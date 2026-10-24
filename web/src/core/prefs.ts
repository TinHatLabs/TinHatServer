// prefs.ts — device preferences in localStorage `tinhat.pref.<key>` (native: one flag file per
// key in the desktop's config dir, settings.rs overlay_pref_* / ui_pref / pref).
//
//   const vol = usePref("snd.volume", 70);          // number
//   const on  = usePref("snd.send", true);          // boolean — stored "1"/"0" like the native flags
//   const theme = usePref("theme", "oled");         // string — stored raw
//   const hidden = usePref<string[]>("call-hidden", []);  // object/array — stored as JSON
//   setPref("snd.volume", 55);  removePref("clock");
//   const [v, setV] = usePrefState("reduce-motion", false);
//
// The TYPE of the default decides how the stored string is read, so always pass a default of
// the right type. Use the SAME key names as the native (list below) so settings stay one-to-one.
// Values change live across components AND other tabs (storage event).
//
// KEY NAMES = the name the native QML passes: settings.uiPref("reduce-motion"),
// settings.pref("snd.volume"), and the overlay flag-file names ("call-layout", "record-optout").
// The native stores ui prefs in files called "ui-<key>"; that "ui-" prefix is accepted and
// stripped here, so "ui-reduce-motion" and "reduce-motion" are the same pref (FOUNDATION-UI uses
// the prefixed form for window geometry "ui-<windowId>-{w,h,x,y,max}").
//
// Account-scoped JSON blobs (native ui_blob: chat drafts, Memories resume points) use
// getBlob/setBlob → `tinhat.blob.<key>`; they are removed on sign-out with the session.
import { useCallback, useRef, useSyncExternalStore } from "react";

const PREFIX = "tinhat.pref.";
const BLOB_PREFIX = "tinhat.blob.";

/**
 * Native pref keys (so feature agents reuse them instead of inventing new ones):
 *   theme ("oled"|"goose")  nav_mode  tour_seen  space_order
 *   snd.volume (0..100, default 70)  snd.send snd.receive snd.notify snd.ring snd.callchime
 *   snd.mutedtalk ("1" = on, default off)  snd.notify.variant snd.ring.variant (""|"2"|"3"|"4")
 *   notify.calls  desktop-notifications  calendar-reminders
 *   call-layout ("auto"|"gallery"|"speaker"|"sidebar")  call-hidden (JSON string[])
 *   call-tileview (JSON object)  call-pane-frac  call-collapsed  record-optout
 *   call-bar-pinned ("1" = the call bar stays shown — "Keep call buttons visible", 11.0.2; anything else / absent = it
 *                    hides 3 s after the pointer stops; features/callui/chrome.ts)
 *   overlay-enabled overlay-mode overlay-corner overlay-hide-share
 *   reduce-motion  gif-autoplay ("1" default — GPU.md §2.6)
 *   call-unfocused-saver (off unless "1" — since 10.8.1 the master switch of every unfocused rule, GPU.md §1;
 *                         Settings → Appearance → Performance; core/lowgpu.ts unfocusedSaverOn)
 *   clock  last-room  bubble-w bubble-h  pip-x pip-y pip-w pip-h
 *   watchparty-volume watchparty-muted  memories-volume memories-muted  soundboard-recent
 *   theme-recent (JSON string[] — the ☰ Theme menu's recent themes, THEMES-UI §12; written by ui/themeStore only)
 *   <windowId>-w/-h/-x/-y/-max (WindowMemory.qml; main window = "main")
 *   formFactor ("auto"|"desktop"|"mobile" — web only, Settings → Appearance → Layout)
 * Blobs: chat-drafts  memories-resume
 */
export const NATIVE_PREF_KEYS = [
  "theme",
  "nav_mode",
  "tour_seen",
  "space_order",
  "snd.volume",
  "snd.send",
  "snd.receive",
  "snd.notify",
  "snd.ring",
  "snd.callchime",
  "snd.mutedtalk",
  "snd.notify.variant",
  "snd.ring.variant",
  "notify.calls",
  "desktop-notifications",
  "calendar-reminders",
  "call-layout",
  "call-hidden",
  "call-tileview",
  "call-pane-frac",
  "call-collapsed",
  "call-bar-pinned",
  "record-optout",
  "overlay-enabled",
  "overlay-mode",
  "overlay-corner",
  "overlay-hide-share",
  "reduce-motion",
  "gif-autoplay",
  "call-unfocused-saver",
  "clock",
  "last-room",
  "bubble-w",
  "bubble-h",
  "pip-x",
  "pip-y",
  "pip-w",
  "pip-h",
  "watchparty-volume",
  "watchparty-muted",
  "memories-volume",
  "memories-muted",
  "soundboard-recent",
  "theme-recent",
  "formFactor",
] as const;

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function notify(fullKey: string) {
  for (const l of listeners.get(fullKey) ?? []) l();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === null) {
      for (const k of listeners.keys()) notify(k);
    } else if (e.key.startsWith("tinhat.")) {
      notify(e.key);
    }
  });
}

function subscribeKey(fullKey: string, cb: Listener): () => void {
  let set = listeners.get(fullKey);
  if (!set) listeners.set(fullKey, (set = new Set()));
  set.add(cb);
  return () => set!.delete(cb);
}

// ---- raw -------------------------------------------------------------------------------------

/** Canonical key: the native file prefix "ui-" is dropped ("ui-clock" ≡ "clock"). */
export function prefKey(key: string): string {
  return key.startsWith("ui-") ? key.slice(3) : key;
}

export function getPrefRaw(key: string): string | null {
  return storage()?.getItem(PREFIX + prefKey(key)) ?? null;
}

export function setPrefRaw(key: string, raw: string | null): void {
  const s = storage();
  if (!s) return;
  const full = PREFIX + prefKey(key);
  if (raw === null) s.removeItem(full);
  else s.setItem(full, raw);
  notify(full);
}

// ---- typed -----------------------------------------------------------------------------------

export type PrefValue = string | number | boolean | null | object;
/** "oled" → string, 70 → number, true → boolean (a literal default must not narrow the result). */
export type Widen<T> = T extends string ? string : T extends number ? number : T extends boolean ? boolean : T;

function serialize(v: PrefValue): string {
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function parse<T extends PrefValue>(raw: string | null, def: T): T {
  if (raw === null) return def;
  switch (typeof def) {
    case "boolean":
      if (raw === "1" || raw === "true") return true as T;
      if (raw === "0" || raw === "false") return false as T;
      return def;
    case "number": {
      const n = Number(raw);
      return (Number.isFinite(n) && raw.trim() !== "" ? n : def) as T;
    }
    case "string":
      return raw as T;
    default:
      try {
        return JSON.parse(raw) as T;
      } catch {
        return def;
      }
  }
}

export function getPref<T extends PrefValue>(key: string, def: T): Widen<T> {
  return parse(getPrefRaw(key), def) as Widen<T>;
}

export function setPref(key: string, value: PrefValue): void {
  setPrefRaw(key, value === undefined ? null : serialize(value));
}

export function removePref(key: string): void {
  setPrefRaw(key, null);
}

/** Subscribe to one pref key (non-React). */
export function onPrefChange(key: string, cb: () => void): () => void {
  return subscribeKey(PREFIX + prefKey(key), cb);
}

/** React: the pref's current value (typed by `def`), live. */
export function usePref<T extends PrefValue>(key: string, def: T): Widen<T> {
  const defRef = useRef(def); // a literal default ({} / []) must not change the snapshot each render
  const cache = useRef<{ raw: string | null; value: T } | null>(null);
  const subscribe = useCallback((cb: Listener) => subscribeKey(PREFIX + prefKey(key), cb), [key]);
  const get = useCallback(() => {
    const raw = getPrefRaw(key);
    if (cache.current && cache.current.raw === raw) return cache.current.value;
    const value = parse(raw, defRef.current);
    cache.current = { raw, value };
    return value;
  }, [key]);
  return useSyncExternalStore(subscribe, get, get) as Widen<T>;
}

/** React: [value, setter] pair. */
export function usePrefState<T extends PrefValue>(key: string, def: T): [Widen<T>, (v: Widen<T>) => void] {
  const v = usePref(key, def);
  const set = useCallback((next: Widen<T>) => setPref(key, next as PrefValue), [key]);
  return [v, set];
}

// ---- account blobs (native ui_blob) ----------------------------------------------------------

const BLOB_MAX = 65_536;

export function getBlob<T = unknown>(key: string, def: T): T {
  const raw = storage()?.getItem(BLOB_PREFIX + key);
  if (!raw) return def;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return def;
  }
}

/** Store a JSON blob (≤ 64 KB serialised, like the native cap). Returns false if refused. */
export function setBlob(key: string, value: unknown): boolean {
  const s = storage();
  if (!s) return false;
  const raw = JSON.stringify(value);
  if (raw.length > BLOB_MAX) return false;
  s.setItem(BLOB_PREFIX + key, raw);
  notify(BLOB_PREFIX + key);
  return true;
}

export function onBlobChange(key: string, cb: () => void): () => void {
  return subscribeKey(BLOB_PREFIX + key, cb);
}
