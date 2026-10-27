// clipsrc.ts — core/clipurl.ts's rules applied to THIS page: the API path (core/api API_BASE) and this server's own API
// bases (core/server ownApiBases: the page's origin, the API base the well-known announces, former names). The one entry
// point for "where does this stored sound / this signed media link play from" (soundboard, join sounds, the calls
// engine, Memories).
import { API_BASE } from "@/core/api";
import { clipUrlWith, rehomeApiUrl } from "@/core/clipurl";
import { ownApiBases } from "@/core/server/store";

/** Where stored sound `src` plays from ("" = refused: FOREIGN_SOUND_NOTE). */
export function clipSrc(src: string): string {
  return clipUrlWith(src, API_BASE, ownApiBases());
}

/** A signed link of this server's API (Memories files / thumbs, uploads) on this page's own /api; anything else as is. */
export function ownApiPath(url: string): string {
  if (!url) return url;
  const r = rehomeApiUrl(url, API_BASE, ownApiBases());
  return r || url;
}
