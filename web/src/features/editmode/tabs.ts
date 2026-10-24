// tabs.ts — which tab of each stack is shown (EDITMODE-UI §4.4): the view state's `active` map, device-local (pref
// `layout-tabs`, JSON {stackId: islandRef}), never synced and never an undo step.
import { useSyncExternalStore } from "react";
import { getPrefRaw, onPrefChange, setPrefRaw } from "@/core/prefs";

export const TABS_PREF = "layout-tabs";
let cacheRaw: string | null | undefined;
let cache: Record<string, string> = {};

export function getTabs(): Record<string, string> {
  const raw = getPrefRaw(TABS_PREF);
  if (raw === cacheRaw) return cache;
  cacheRaw = raw;
  const out: Record<string, string> = {};
  try {
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    if (v && typeof v === "object" && !Array.isArray(v))
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === "string") out[k] = x;
  } catch {
    /* a broken pref reads as no choice */
  }
  cache = out;
  return cache;
}

export function useTabs(): Record<string, string> {
  return useSyncExternalStore((cb) => onPrefChange(TABS_PREF, cb), getTabs, getTabs);
}

export function setTab(stackId: string, ref: string): void {
  const next = { ...getTabs(), [stackId]: ref };
  setPrefRaw(TABS_PREF, JSON.stringify(next));
}
