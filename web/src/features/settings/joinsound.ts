// joinsound.ts — the Profile pane's join-sound helpers: personal sounds (account data
// dev.tinhat.soundboard_personal, read here; "Use" appends read-modify-write keeping unknown
// entries), myinstants search through the server's Tin Hat API (/api/soundboard/search, 450 ms debounce, previous
// request aborted) and the local preview player via the clip cache (media.md clipUrlFor).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { apiJson } from "@/core/api";
import { toast } from "@/core/bus";
import { FOREIGN_SOUND_NOTE } from "@/core/clipurl";
import { clipSrc } from "@/core/clipsrc";
import { getClient } from "@/core/matrix";
import { createLogger } from "@/core/log";
import { playClip, stopClip, type ClipHandle } from "@/core/sounds";

const log = createLogger("joinsound");
export const PERSONAL_TYPE = "dev.tinhat.soundboard_personal";

export interface PersonalSound {
  name?: string;
  sourceUrl?: string;
  url?: string;
  emoji?: string;
  duration?: number;
  [k: string]: unknown;
}

export interface SearchHit {
  name: string;
  url: string;
  duration: number;
  emoji?: string;
}

/** media.md clipUrlFor (core/clipurl.ts, M9): myinstants → the server's clip cache, own uploads → this origin, "" =
 *  refused (a foreign link never plays). */
export function clipUrlFor(u: string): string {
  return clipSrc(u);
}

function normalizeHits(raw: unknown): SearchHit[] {
  const arr = Array.isArray(raw)
    ? raw
    : ((raw as Record<string, unknown>)?.results ?? (raw as Record<string, unknown>)?.sounds ?? (raw as Record<string, unknown>)?.data ?? []);
  if (!Array.isArray(arr)) return [];
  const out: SearchHit[] = [];
  for (const r of arr as Array<Record<string, unknown>>) {
    let url = String(r.url ?? r.sound ?? r.mp3 ?? "");
    if (!url && typeof r.mp3Path === "string") url = `https://www.myinstants.com${r.mp3Path.startsWith("/") ? "" : "/"}${r.mp3Path}`;
    const name = String(r.name ?? r.title ?? "");
    if (!name && !url) continue;
    out.push({ name, url, duration: Number(r.duration) || 0, emoji: typeof r.emoji === "string" ? r.emoji : undefined });
  }
  return out;
}

/** Search state for a query (empty → cleared, in-flight aborted). */
export function useSoundSearch(q: string): { searching: boolean; results: SearchHit[] } {
  const [st, setSt] = useState<{ searching: boolean; results: SearchHit[] }>({ searching: false, results: [] });
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => {
    ctl.current?.abort();
    const query = q.trim();
    if (!query) {
      setSt({ searching: false, results: [] });
      return;
    }
    setSt((s) => ({ ...s, searching: true }));
    const c = new AbortController();
    ctl.current = c;
    const t = setTimeout(() => {
      apiJson<unknown>(`/soundboard/search?q=${encodeURIComponent(query)}`, { signal: c.signal })
        .then((r) => {
          if (!c.signal.aborted) setSt({ searching: false, results: normalizeHits(r) });
        })
        .catch((e) => {
          if (c.signal.aborted) return;
          log.info("search failed", (e as Error)?.message);
          setSt({ searching: false, results: [] });
        });
    }, 450);
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [q]);
  return st;
}

/** Append a sound to the personal board (read-modify-write, unknown entries kept). */
export async function addPersonalSound(name: string, url: string, emoji: string, duration: number): Promise<void> {
  const c = getClient();
  const cur = (c.getAccountData(PERSONAL_TYPE as never)?.getContent() ?? {}) as { sounds?: PersonalSound[] };
  const sounds = Array.isArray(cur.sounds) ? [...cur.sounds] : [];
  if (sounds.some((s) => (s.sourceUrl || s.url || "") === url)) return;
  sounds.push({ name, sourceUrl: url, duration, emoji });
  await c.setAccountData(PERSONAL_TYPE as never, { ...cur, sounds } as never);
}

// ---- local preview player (never into a call) ---------------------------------------------------

// REACH A5.8: through the one Web Audio context (core/sounds playClip, the "preview" channel) — an <audio>
// element is media playback on iOS (Now Playing, the Dynamic Island).
let clip: ClipHandle | null = null;
let playingUrl = "";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function togglePreview(url: string): void {
  if (!url) return;
  if (playingUrl === url) {
    stopPreview();
    return;
  }
  stopPreview();
  playingUrl = url;
  emit();
  const done = () => {
    if (playingUrl === url) {
      playingUrl = "";
      clip = null;
      emit();
    }
  };
  const src = clipUrlFor(url);
  if (!src) {
    toast(FOREIGN_SOUND_NOTE);
    done();
    return;
  }
  void playClip(src, { channel: "preview", onEnded: done }).then((h) => {
    if (playingUrl !== url) return h?.stop();
    if (!h) {
      log.warn("[joinsound] preview error", url);
      done();
    } else clip = h;
  });
}

export function stopPreview(): void {
  clip?.stop();
  clip = null;
  stopClip("preview");
  if (playingUrl) {
    playingUrl = "";
    emit();
  }
}

export function usePlayingUrl(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => playingUrl,
  );
}
