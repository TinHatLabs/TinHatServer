// soundboard/data.ts — the soundboard's data layer (port of native soundboard.rs data functions).
//
//   Favourites  global account data `dev.tinhat.soundboard_personal` {sounds:[{name,sourceUrl,duration,emoji?}]}
//               read-modify-write of the RAW array (unknown entries/fields survive), PUT via the client.
//   Room sounds one `dev.tinhat.soundboard` state event per sound, state_key = UUIDv4, `{}` tombstone.
//   Web search  GET /api/soundboard/search?q= → normalised [{name,url,duration}] (myinstants).
//   Upload      POST /api/soundboard/upload (bearer, multipart name+file ≤ 3 MB) → added to favourites.
import { useMemo } from "react";
import { Method } from "matrix-js-sdk";
import { apiFetch } from "@/core/api";
import { ensureWritable, getClient, peekClient, sendState, useAccountData, useRoomStateEvents } from "@/core/matrix";
import { createLogger } from "@/core/log";
import { withRetry } from "../shared/retry";

const log = createLogger("soundboard");

export const PERSONAL_TYPE = "dev.tinhat.soundboard_personal";
export const ROOM_TYPE = "dev.tinhat.soundboard";
const MYINSTANTS_BASE = "https://www.myinstants.com";
export const MAX_UPLOAD = 3 * 1024 * 1024;

export interface Sound {
  name: string;
  /** canonical source URL (native `sourceUrl`; web results use `url` → normalised here) */
  sourceUrl: string;
  emoji: string;
  duration: number;
  /** room sounds */
  stateKey?: string;
  setBy?: string;
  addedAt?: number;
}

type Json = Record<string, unknown>;

function toU64(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.trunc(v));
  return 0;
}

/** One sound's content, validated (native read_sound_content). null = tombstone / invalid. */
export function readSound(c: unknown): Sound | null {
  if (!c || typeof c !== "object") return null;
  const o = c as Json;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  const url = typeof o.sourceUrl === "string" ? o.sourceUrl.trim() : "";
  if (!name || !url) return null;
  return { name, sourceUrl: url, emoji: typeof o.emoji === "string" ? o.emoji : "", duration: toU64(o.duration) };
}

// ---- favourites (personal) -------------------------------------------------------------------

function rawFromContent(c: unknown): unknown[] {
  const s = (c as Json | undefined)?.sounds;
  return Array.isArray(s) ? [...s] : [];
}

/** Validated favourites (display list) — live from the synced account data. */
export function usePersonalSounds(): Sound[] {
  const content = useAccountData(PERSONAL_TYPE);
  return useMemo(() => rawFromContent(content).map(readSound).filter((s): s is Sound => !!s), [content]);
}

/** Whether the account data has been seen (distinguishes "none yet" from "empty"). */
export function useHasPersonalData(): boolean {
  return useAccountData(PERSONAL_TYPE) !== undefined;
}

/** Server fetch of the RAW array (native load_personal_sounds_raw) — falls back to the store. */
async function loadPersonalRaw(): Promise<unknown[]> {
  const c = getClient();
  try {
    const me = encodeURIComponent(c.getUserId() ?? "");
    const content = await c.http.authedRequest<Json>(Method.Get, `/user/${me}/account_data/${PERSONAL_TYPE}`);
    return rawFromContent(content);
  } catch (e) {
    if ((e as { data?: { errcode?: string } })?.data?.errcode === "M_NOT_FOUND") return [];
    log.warn(`fetch personal failed: ${(e as Error)?.message ?? e}`);
    return rawFromContent(c.getAccountData(PERSONAL_TYPE as never)?.getContent());
  }
}

async function writePersonalRaw(sounds: unknown[]): Promise<void> {
  await getClient().setAccountData(PERSONAL_TYPE as never, { sounds } as never);
}

/**
 * Server copy of the validated favourites (native refresh on open: the popover shows the synced
 * copy at once and swaps in the server copy when it lands — e.g. right after another device wrote).
 */
export async function fetchPersonalSounds(): Promise<Sound[] | null> {
  if (!peekClient()) return null;
  try {
    return (await loadPersonalRaw()).map(readSound).filter((s): s is Sound => !!s);
  } catch {
    return null;
  }
}

export async function addPersonalSound(name: string, sourceUrl: string, emoji = "", duration = 0): Promise<void> {
  const sounds = await loadPersonalRaw();
  const entry: Json = { name: name.trim(), sourceUrl: sourceUrl.trim(), duration: Math.max(0, Math.trunc(duration)) };
  if (emoji.trim()) entry.emoji = emoji.trim();
  sounds.push(entry);
  await writePersonalRaw(sounds);
}

/** Drop the i-th DISPLAYED favourite (mapped back onto the raw array — loss-free). */
export async function removePersonalSound(displayIndex: number): Promise<void> {
  if (displayIndex < 0) return;
  const sounds = await loadPersonalRaw();
  let seen = 0;
  const pos = sounds.findIndex((s) => {
    if (readSound(s)) {
      if (seen === displayIndex) return true;
      seen++;
    }
    return false;
  });
  if (pos < 0) return;
  sounds.splice(pos, 1);
  await writePersonalRaw(sounds);
}

// ---- room sounds -----------------------------------------------------------------------------

/** A room's sounds, newest first (addedAt desc), owner = event sender. Paints from local state. */
export function useRoomSounds(roomId: string | null | undefined): Sound[] {
  const evs = useRoomStateEvents(roomId, ROOM_TYPE);
  return useMemo(() => {
    const out: Sound[] = [];
    for (const e of evs) {
      const s = readSound(e.content);
      if (!s) continue;
      out.push({ ...s, stateKey: e.stateKey, setBy: e.sender, addedAt: toU64((e.content as Json).addedAt) });
    }
    out.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
    return out;
  }, [evs]);
}

export function uuidV4(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function addRoomSound(roomId: string, name: string, sourceUrl: string, emoji = "", duration = 0): Promise<void> {
  await ensureWritable(roomId, [ROOM_TYPE]);
  const content: Json = {
    name: name.trim(),
    sourceUrl: sourceUrl.trim(),
    duration: Math.max(0, Math.trunc(duration)),
    addedAt: Date.now(),
  };
  const me = peekClient()?.getUserId();
  if (me) content.addedBy = me;
  if (emoji.trim()) content.emoji = emoji.trim();
  const key = uuidV4();
  await withRetry(() => sendState(roomId, ROOM_TYPE, key, content));
}

export async function removeRoomSound(roomId: string, stateKey: string): Promise<void> {
  if (!stateKey) return;
  await withRetry(() => sendState(roomId, ROOM_TYPE, stateKey, {}));
}

// ---- web search ------------------------------------------------------------------------------

/**
 * Decode the HTML entities myinstants leaves in names ("He&#x27;s in boys") — the native shows them
 * raw (logged in docs/native-bugs/media.md); the web shows (and stores) the real characters.
 */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16) || 0x3f);
    if (k.startsWith("#")) return String.fromCodePoint(parseInt(k.slice(1), 10) || 0x3f);
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" } as Record<string, string>)[k] ?? m;
  });
}

/** Normalise the proxy's results (bare array or {results|sounds|data}) → [{name,url,duration}]. */
export function normalizeSearchResults(v: unknown): Sound[] {
  let arr: unknown[] = [];
  if (Array.isArray(v)) arr = v;
  else if (v && typeof v === "object") {
    for (const k of ["results", "sounds", "data"]) {
      const x = (v as Json)[k];
      if (Array.isArray(x)) {
        arr = x;
        break;
      }
    }
  }
  const out: Sound[] = [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const o = it as Json;
    const name = typeof o.name === "string" ? decodeEntities(o.name.trim()) : "";
    let url = "";
    for (const k of ["url", "sound", "mp3"]) {
      const u = o[k];
      if (typeof u === "string" && u.startsWith("http")) {
        url = u;
        break;
      }
    }
    if (!url && typeof o.mp3Path === "string") {
      const p = o.mp3Path;
      url = p.startsWith("http") ? p : `${MYINSTANTS_BASE}${p.startsWith("/") ? p : `/${p}`}`;
    }
    if (!url) continue;
    out.push({ name: name || url, sourceUrl: url, emoji: "", duration: toU64(o.duration) });
  }
  return out;
}

export async function searchSounds(q: string, signal?: AbortSignal): Promise<Sound[]> {
  const r = await apiFetch(`/soundboard/search?q=${encodeURIComponent(q)}`, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return normalizeSearchResults(await r.json());
}

// ---- upload ----------------------------------------------------------------------------------

/** Picker/drop name: file name without extension, URI-decoded, `_`/`-` runs → spaces, ≤ 80 chars. */
export function nameFromFile(fileName: string): string {
  let base = fileName.substring(fileName.lastIndexOf("/") + 1).replace(/\.[a-z0-9]+$/i, "");
  try {
    base = decodeURIComponent(base);
  } catch {
    /* keep raw */
  }
  return base.replace(/[_-]+/g, " ").trim().slice(0, 80);
}

const MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  webm: "audio/webm",
};

/** Upload a clip and add it to favourites. Resolves with the stored name; throws the native error text. */
export async function uploadClip(file: File, name?: string): Promise<string> {
  if (file.size > MAX_UPLOAD) throw new Error("Upload failed: bigger than 3 MB");
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    throw new Error("That file couldn't be read");
  }
  const nm = (name ?? nameFromFile(file.name)).slice(0, 80) || nameFromFile(file.name) || "clip";
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const fd = new FormData();
  fd.append("name", nm);
  fd.append("file", new Blob([bytes], { type: file.type || MIME[ext] || "application/octet-stream" }), file.name.replace(/"/g, "") || "clip");
  let r: Response;
  try {
    r = await apiFetch("/soundboard/upload", { method: "POST", body: fd, timeoutMs: 60000 });
  } catch (e) {
    throw new Error(`Upload failed: network: ${(e as Error)?.message ?? e}`);
  }
  const text = await r.text();
  let body: Json | null = null;
  try {
    body = text ? (JSON.parse(text) as Json) : null;
  } catch {
    body = null;
  }
  if (!r.ok) {
    const err = typeof body?.error === "string" && body.error ? body.error : `HTTP ${r.status}`;
    throw new Error(`Upload failed: ${err}`);
  }
  const url = typeof body?.url === "string" ? body.url : "";
  if (!url) throw new Error("Upload failed: bad reply: no url in reply");
  const stored = typeof body?.name === "string" && body.name ? body.name : nm;
  try {
    await addPersonalSound(stored, url, "", 0);
  } catch (e) {
    throw new Error(`Upload failed: saved on the server but not in your list: ${(e as Error)?.message ?? e}`);
  }
  return stored;
}

// ---- join sound (extended profile field) -----------------------------------------------------

export const JOINSOUND_KEY = "dev.tinhat.joinsound";

/** My join sound url ("" when unset / 404). */
export async function fetchJoinSound(userId?: string): Promise<string> {
  const c = getClient();
  const me = userId ?? c.getUserId() ?? "";
  try {
    const res = await c.http.authedRequest<Json>(Method.Get, `/profile/${encodeURIComponent(me)}/${JOINSOUND_KEY}`);
    const v = res?.[JOINSOUND_KEY];
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

/** Save (or clear with "") my join sound. */
export async function saveJoinSound(url: string): Promise<void> {
  const c = getClient();
  const me = c.getUserId() ?? "";
  await c.http.authedRequest(Method.Put, `/profile/${encodeURIComponent(me)}/${JOINSOUND_KEY}`, undefined, { [JOINSOUND_KEY]: url.trim() });
}
