// linkpreview.ts — Synapse preview_url (never the client fetching the site), cached in IndexedDB
// `tinhat-web-linkpreview`: 7 days for a preview, 6 h for "none"; two fetches at a time (linkpreview.rs).
import { useEffect, useState } from "react";
import { peekClient } from "@/core/matrix";

export interface LinkPreview {
  url: string;
  site: string;
  title: string;
  description: string;
  image: string; // mxc
  imageW: number;
  imageH: number;
  host: string;
}

const DB = "tinhat-web-linkpreview";
const POS_TTL = 7 * 86400000;
const NEG_TTL = 6 * 3600000;
const mem = new Map<string, { at: number; v: LinkPreview | null }>();

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("p");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
let dbp: Promise<IDBDatabase> | null = null;
async function dbGet(k: string): Promise<{ at: number; v: LinkPreview | null } | undefined> {
  try {
    dbp ??= idb();
    const db = await dbp;
    return await new Promise((res) => {
      const t = db.transaction("p").objectStore("p").get(k);
      t.onsuccess = () => res(t.result);
      t.onerror = () => res(undefined);
    });
  } catch {
    return undefined;
  }
}
async function dbPut(k: string, v: { at: number; v: LinkPreview | null }) {
  try {
    dbp ??= idb();
    const db = await dbp;
    db.transaction("p", "readwrite").objectStore("p").put(v, k);
  } catch {
    /* ignore */
  }
}

const cut = (s: unknown, n: number) => {
  const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

// two at a time
let running = 0;
const queue: Array<() => void> = [];
function slot<T>(f: () => Promise<T>): Promise<T> {
  return new Promise((res, rej) => {
    const go = () => {
      running++;
      f()
        .then(res, rej)
        .finally(() => {
          running--;
          queue.shift()?.();
        });
    };
    if (running < 2) go();
    else queue.push(go);
  });
}

const inflight = new Map<string, Promise<LinkPreview | null>>();

async function fetchPreview(url: string): Promise<LinkPreview | null> {
  const c = peekClient();
  if (!c) return null;
  const hs = c.getHomeserverUrl().replace(/\/+$/, "");
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`${hs}/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(url)}`, {
      headers: { Authorization: `Bearer ${c.getAccessToken()}` },
      signal: ctl.signal,
    });
    if (!r.ok) return null;
    const j = (await r.json()) as Record<string, unknown>;
    const title = cut(j["og:title"], 160);
    const description = cut(j["og:description"], 320);
    let image = typeof j["og:image"] === "string" && (j["og:image"] as string).startsWith("mxc://") ? (j["og:image"] as string) : "";
    const size = Number(j["matrix:image:size"] ?? 0);
    if (size > 4 * 1024 * 1024) image = "";
    if (!title && !description && !image) return null;
    let host = "";
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      /* ignore */
    }
    return {
      url,
      site: cut(j["og:site_name"], 60),
      title,
      description,
      image,
      imageW: Number(j["og:image:width"] ?? 0) || 0,
      imageH: Number(j["og:image:height"] ?? 0) || 0,
      host,
    };
  } finally {
    window.clearTimeout(timer);
  }
}

export async function getPreview(url: string): Promise<LinkPreview | null> {
  const now = Date.now();
  const m = mem.get(url);
  if (m && now - m.at < (m.v ? POS_TTL : NEG_TTL)) return m.v;
  const p = inflight.get(url);
  if (p) return p;
  const job = (async () => {
    const d = await dbGet(url);
    if (d && now - d.at < (d.v ? POS_TTL : NEG_TTL)) {
      mem.set(url, d);
      return d.v;
    }
    let v: LinkPreview | null = null;
    try {
      v = await slot(() => fetchPreview(url));
    } catch {
      v = null;
    }
    const e = { at: Date.now(), v };
    mem.set(url, e);
    void dbPut(url, e);
    return v;
  })();
  inflight.set(url, job);
  try {
    return await job;
  } finally {
    inflight.delete(url);
  }
}

/** Cached value at once, unknown URLs fetched after paint. */
export function useLinkPreview(url: string | null, enabled: boolean): LinkPreview | null {
  const [v, setV] = useState<{ url: string; p: LinkPreview | null } | null>(() => (url ? { url, p: mem.get(url)?.v ?? null } : null));
  useEffect(() => {
    if (!url || !enabled) return;
    let alive = true;
    const t = window.setTimeout(() => {
      void getPreview(url).then((p) => alive && setV({ url, p }));
    }, 30);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [url, enabled]);
  if (!url) return null;
  if (v?.url === url) return v.p;
  return mem.get(url)?.v ?? null;
}
