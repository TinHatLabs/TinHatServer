// around/covers.ts — a game's portrait cover from its NAME (WIDGETS.md §8 amendment): the games catalogue's search
// result whose name equals it case-insensitively → its art; else "" (the row shows the activity's emoji tile). Cached
// for the session, one request per name.
import { useEffect, useState } from "react";
import { apiJson } from "@/core/api";
import { serverFeatureOn } from "@/core/server";
import { CATALOG_BASE, artUrl } from "@/features/calendar";

const cache = new Map<string, string | Promise<string>>();

async function lookup(name: string, key: string): Promise<string> {
  if (!serverFeatureOn("games")) return ""; // docs/SELFHOST.md: no catalogue on this server → the emoji tile
  try {
    const v = await apiJson<Record<string, unknown>>(`/games/search?q=${encodeURIComponent(name)}`, { timeoutMs: 15000 });
    const list = (Array.isArray(v.items) ? v.items : Array.isArray(v.results) ? v.results : Array.isArray(v) ? v : []) as Array<Record<string, unknown>>;
    const hit = list.find((x) => String(x?.name ?? "").trim().toLowerCase() === key);
    return hit && hit.id !== undefined ? artUrl(CATALOG_BASE, String(hit.id), "portrait") : "";
  } catch {
    return "";
  }
}

export function useGameCover(name: string | null | undefined): string {
  const clean = (name ?? "").trim();
  const key = clean.toLowerCase();
  const hit = cache.get(key);
  const [url, setUrl] = useState(typeof hit === "string" ? hit : "");
  useEffect(() => {
    if (!key) {
      setUrl("");
      return;
    }
    const cur = cache.get(key);
    if (typeof cur === "string") {
      setUrl(cur);
      return;
    }
    let alive = true;
    const p = cur ?? lookup(clean, key);
    cache.set(key, p);
    void p.then((u) => {
      cache.set(key, u);
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [key, clean]);
  return key ? url : "";
}
