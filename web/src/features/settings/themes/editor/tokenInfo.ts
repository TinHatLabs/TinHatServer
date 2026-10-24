// tokenInfo.ts — the areas and descriptions of the element tokens (src/theme/tokens.json), which the runtime's compact
// token spec leaves out: the theme editor's Advanced mode groups by area, searches descriptions and shows them as
// tooltips (THEMES-UI.md §13.8). Loaded as its own chunk when the editor opens (never in the boot path).
import { useSyncExternalStore } from "react";
import type { TokenInfo } from "@/theme/labels";

let info: Map<string, TokenInfo> | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function loadTokenInfo(): Promise<void> {
  if (info) return Promise.resolve();
  loading ??= import("@/theme/tokens.json").then((m) => {
    const j = (m as unknown as { default: { tokens: TokenInfo[] } }).default;
    info = new Map(j.tokens.map((t) => [t.id, { id: t.id, area: t.area, description: t.description }]));
    for (const l of listeners) l();
  });
  return loading;
}
const snap = () => info;
export function useTokenInfo(): Map<string, TokenInfo> | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    snap,
    snap,
  );
}
/** A token's area (tokens.json), or its first id segment until the list is in. */
export function tokenArea(id: string): string {
  return info?.get(id)?.area ?? id.split(".")[0];
}
export function tokenDescription(id: string): string {
  return info?.get(id)?.description ?? "";
}
