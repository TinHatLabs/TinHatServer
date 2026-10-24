// shortcutsStore.ts — this device's own keys (ACTIONS.md §8.5): the user document in the device pref `shortcuts` (never
// synced: keyboards differ per device), the bindings in effect (bindings.ts, cached per stored text) and what the hosts
// ask of them — the keys an action has, whether a feature's default key still belongs to its action, push to talk's key.
// The desktop's twin: ActionsHost.qml (shortcutsDocText, keysFor, winningKeys, pttKeys).
import { useSyncExternalStore } from "react";
import { getPrefRaw, onPrefChange, removePref, setPref } from "@/core/prefs";
import type { Json } from "@/layout/json";
import { effectiveBindings, readUserBindings, setUserBinding, shortcutsView, type Effective } from "./bindings";

export const SHORTCUTS_PREF = "shortcuts";

let cache: { raw: string | null | undefined; doc: Json | undefined; eff: Effective | null } = { raw: undefined, doc: undefined, eff: null };

function read(): { doc: Json | undefined; eff: Effective } {
  const raw = getPrefRaw(SHORTCUTS_PREF);
  if (raw !== cache.raw || !cache.eff) {
    let doc: Json | undefined;
    if (raw !== null) {
      try {
        doc = JSON.parse(raw) as Json;
      } catch {
        doc = undefined;
      }
    }
    cache = { raw, doc, eff: effectiveBindings("web", doc) };
  }
  return { doc: cache.doc, eff: cache.eff as Effective };
}

/** The stored user document (undefined = none). */
export function shortcutsDoc(): Json | undefined {
  return read().doc;
}

/** The bindings in effect on this device. */
export function effectiveNow(): Effective {
  return read().eff;
}

/** React: the stored document's text (re-renders on a change, in any tab). */
export function useShortcutsRaw(): string | null {
  return useSyncExternalStore(
    (cb) => onPrefChange(SHORTCUTS_PREF, cb),
    () => getPrefRaw(SHORTCUTS_PREF),
    () => getPrefRaw(SHORTCUTS_PREF),
  );
}

/** Settings → Shortcuts' list (§8.8). */
export function shortcutsList() {
  return shortcutsView("web", shortcutsDoc());
}

/** Set an action's keys (null = back to its defaults, [] = no key) — §8.8's edit, stored or removed. */
export function setActionKeys(action: string, keys: string[] | null): void {
  const next = setUserBinding("web", shortcutsDoc(), action, keys);
  if (next === null) removePref(SHORTCUTS_PREF);
  else setPref(SHORTCUTS_PREF, next as object);
}

/** Every action back to Tin Hat's keys. */
export function resetAllShortcuts(): void {
  removePref(SHORTCUTS_PREF);
}

/** The keys an action has now (the person's, else its defaults), in order. */
export function keysOf(action: string): string[] {
  const out: string[] = [];
  for (const b of effectiveNow().bindings) if (b.action === action && !out.includes(b.key)) out.push(b.key);
  return out;
}

/** The keys an action has that are its own right now (no other action took them, §8.6). */
export function winningKeys(action: string): string[] {
  const out: string[] = [];
  for (const b of effectiveNow().bindings) if (b.action === action && b.wins && !out.includes(b.key)) out.push(b.key);
  return out;
}

/** A feature's default key still belongs to its action (the person kept it and gave it to no other action). */
export function defaultLive(action: string, key: string): boolean {
  return effectiveNow().bindings.some((b) => b.action === action && b.key === key && b.source === "default" && b.wins);
}

/** Push to talk's keys (a modifier held alone, or an F-key). */
export function pttKeys(): string[] {
  return winningKeys("call.pushToTalk.hold");
}

/** The actions this device gave keys of its own (an entry in the document, [] included). */
export function changedActions(): Set<string> {
  return new Set(Object.keys(readUserBindings("web", shortcutsDoc()).entries));
}
