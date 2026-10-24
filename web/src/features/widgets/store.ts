// store.ts — the widget list (contract WIDGETS.md §1: `[{w, size?, settings?, collapsed?}]`) in the device pref
// `widgets` (JSON) until the dock host's synced layout document carries it (notes/widgets-web.md: the migration copies
// this array into `opts.widgets.widgets` of the layout's `widgets` island). No stored list = the registry defaults;
// `[]` = no widgets (the island is absent — also the pixel gates' switch).
import { useSyncExternalStore } from "react";
import { getPrefRaw, onPrefChange, setPref } from "@/core/prefs";
import { defaultItems, normalizeItems, widgetDef, type WidgetItem, type WidgetSize } from "@/widgets/registry";

export const WIDGETS_PREF = "widgets";

let cacheRaw: string | null | undefined;
let cacheItems: WidgetItem[] = [];

/** The current list (stable identity until the pref changes). */
export function getItems(): WidgetItem[] {
  const raw = getPrefRaw(WIDGETS_PREF);
  if (raw === cacheRaw) return cacheItems;
  cacheRaw = raw;
  let parsed: unknown = undefined;
  if (raw !== null) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
  }
  cacheItems = normalizeItems(parsed) ?? defaultItems();
  return cacheItems;
}

function subscribe(cb: () => void): () => void {
  return onPrefChange(WIDGETS_PREF, cb);
}

/** React: the widget list, live (other tabs too). */
export function useWidgetItems(): WidgetItem[] {
  return useSyncExternalStore(subscribe, getItems, getItems);
}

function write(items: WidgetItem[]): void {
  setPref(WIDGETS_PREF, items);
}

export function hasWidget(w: string): boolean {
  return getItems().some((i) => i.w === w);
}

/** Append a widget at its default size (no-op when it is already there). */
export function addWidget(w: string): void {
  const items = getItems();
  if (items.some((i) => i.w === w) || !widgetDef(w)) return;
  write([...items, { w }]);
}

export function removeWidget(w: string): void {
  write(getItems().filter((i) => i.w !== w));
}

export function patchWidget(w: string, patch: Partial<WidgetItem>): void {
  write(
    getItems().map((i) => {
      if (i.w !== w) return i;
      const next: WidgetItem = { ...i, ...patch };
      for (const k of Object.keys(patch)) if ((patch as Record<string, unknown>)[k] === undefined) delete next[k];
      return next;
    }),
  );
}

export function setSize(w: string, size: WidgetSize): void {
  const def = widgetDef(w);
  patchWidget(w, { size: def && size === def.default ? undefined : size });
}

export function setCollapsed(w: string, collapsed: boolean): void {
  patchWidget(w, { collapsed: collapsed || undefined });
}

export function setSetting(w: string, id: string, value: number | boolean): void {
  const it = getItems().find((i) => i.w === w);
  if (!it) return;
  patchWidget(w, { settings: { ...(it.settings ?? {}), [id]: value } });
}

/** Move a widget to position `to` (0 = top). */
export function moveWidget(w: string, to: number): void {
  const items = [...getItems()];
  const from = items.findIndex((i) => i.w === w);
  if (from < 0) return;
  const [it] = items.splice(from, 1);
  items.splice(Math.max(0, Math.min(items.length, to)), 0, it!);
  write(items);
}
