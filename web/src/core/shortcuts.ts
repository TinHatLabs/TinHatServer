// shortcuts.ts — global keyboard shortcuts with the native's Qt key names.
//
//   const off = registerShortcut({ id: "quick-switcher", keys: "Ctrl+K", whenTyping: true, run: () => … });
//   useShortcut("Escape", () => close(), { enabled: open });     // component-scoped
//   r.shortcuts.add({ id, order, keys: "Ctrl+Shift+E", run })   // registry (bridged by registry.ts)
//
// Sequences use Qt's names: modifiers Ctrl / Shift / Alt / Meta joined with "+", keys "A".."Z",
// "0".."9", "F1".."F12", "Escape"/"Esc", "Return"/"Enter", "Space", "Tab", "Backspace", "Delete",
// "Up"/"Down"/"Left"/"Right", "PgUp"/"PgDown", "Home"/"End", and punctuation (",", ".", "/", …).
// On macOS "Ctrl" also matches ⌘ (Qt maps Ctrl → Command there).
//
// Dispatch: highest `priority` first, then the most recently registered — so a just-opened
// dialog's Escape wins over the shell's. A handler returning `false` passes the key on.
// Shortcuts do NOT fire while the user types in an input/textarea/contenteditable unless
// registered with `whenTyping: true` (native ApplicationShortcuts like Ctrl+K / Ctrl+, should
// set it).
import { useEffect, useRef } from "react";

export interface ShortcutDef {
  id: string;
  keys: string | string[];
  run: (e: KeyboardEvent) => boolean | void;
  whenTyping?: boolean;
  enabled?: () => boolean;
  priority?: number;
  description?: string;
  /** 11.0: the actions-table action these keys are the default keys of (ACTIONS.md §8): the shortcut fires only while
   *  the key still belongs to that action on this device (Settings → Shortcuts may have moved it) */
  action?: string;
}

interface Parsed {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string; // normalised KeyboardEvent.key (lower-case for letters)
  code?: string; // for digits/letters we also accept the physical code (Shift+1 → "!")
}

interface Entry {
  def: ShortcutDef;
  parsed: Parsed[];
  /** the registered sequences, as given (parsed[i] is keys[i]) */
  keys: string[];
  seq: number;
}

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  escape: "escape",
  return: "enter",
  enter: "enter",
  space: " ",
  spacebar: " ",
  tab: "tab",
  backspace: "backspace",
  del: "delete",
  delete: "delete",
  ins: "insert",
  insert: "insert",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  pgup: "pageup",
  pageup: "pageup",
  pgdown: "pagedown",
  pagedown: "pagedown",
  home: "home",
  end: "end",
  plus: "+",
  minus: "-",
  comma: ",",
  period: ".",
};

/** KeyboardEvent.code of the US-layout punctuation keys, so Shift+<punct> still matches. */
const PUNCT_CODES: Record<string, string> = {
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
};

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function parseSequence(seq: string): Parsed {
  // "Ctrl++" / "Ctrl+," — split on "+" but keep a trailing "+" key.
  const parts = seq.endsWith("++") ? [...seq.slice(0, -2).split("+"), "+"] : seq.split("+");
  const p: Parsed = { ctrl: false, shift: false, alt: false, meta: false, key: "" };
  for (const raw of parts) {
    const t = raw.trim();
    const l = t.toLowerCase();
    if (l === "ctrl" || l === "control") p.ctrl = true;
    else if (l === "shift") p.shift = true;
    else if (l === "alt") p.alt = true;
    else if (l === "meta" || l === "cmd" || l === "super") p.meta = true;
    else if (t) {
      p.key = KEY_ALIASES[l] ?? (t.length === 1 ? t.toLowerCase() : l);
      if (/^[a-z]$/i.test(t)) p.code = `Key${t.toUpperCase()}`;
      else if (/^[0-9]$/.test(t)) p.code = `Digit${t}`;
      else if (PUNCT_CODES[p.key]) p.code = PUNCT_CODES[p.key]; // Shift turns "," into "<" etc. (Ctrl+Shift+,)
    }
  }
  return p;
}

function matches(p: Parsed, e: KeyboardEvent): boolean {
  const ctrl = e.ctrlKey || (isMac && e.metaKey && !p.meta);
  const meta = isMac ? e.metaKey && p.meta : e.metaKey;
  if (p.ctrl !== ctrl || p.shift !== e.shiftKey || p.alt !== e.altKey || p.meta !== meta) return false;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  if (key === p.key) return true;
  // Shift/Alt change e.key for letters/digits/punctuation on many layouts: fall back to the code.
  if (p.code && e.code === p.code) return true;
  return false;
}

function isTyping(e: KeyboardEvent): boolean {
  const t = (e.composedPath?.()[0] ?? e.target) as HTMLElement | null;
  if (!t || !(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (t as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type);
  }
  return false;
}

let seqCounter = 0;
const entries = new Map<string, Entry>();

// ---- 11.0: a person's own keys (ACTIONS.md §8; installed by features/actions) ------------------------------------
// The canonical text of a key press (the actions table's key names: A–Z, 0–9, F1–F24, Up, PgDown, Return, ",", …):
// a letter by the letter the layout types (Qt's rule, like the desktop and the registered shortcuts: AZERTY's A is "A"),
// else — a non-Latin layout, or ⌥ on a Mac — by its physical key; digits and punctuation by their physical key (event.code,
// US positions), so Shift never renames them.
const CODE_PUNCT: Record<string, string> = {
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Minus: "-", Equal: "=", Backquote: "`", NumpadAdd: "+",
};
const NAMED_KEYS: Record<string, string> = {
  Escape: "Escape", Enter: "Return", " ": "Space", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", PageUp: "PgUp", PageDown: "PgDown",
  Home: "Home", End: "End", Pause: "Pause", PrintScreen: "Print", ContextMenu: "Menu",
};
const MODIFIER_KEYS: Record<string, string> = { Control: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Meta" };
/** The key of a key event by the table's name ("K", "F5", "Up", ",", a modifier "Ctrl"), or null (a key it has none for). */
export function eventKeyName(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS[e.key]) return MODIFIER_KEYS[e.key];
  const c = e.code ?? "";
  if (/^[a-z]$/i.test(e.key)) return e.key.toUpperCase();
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  if (/^[0-9]$/.test(e.key)) return e.key; // the number pad
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) return e.key;
  if (NAMED_KEYS[e.key]) return NAMED_KEYS[e.key];
  if (CODE_PUNCT[c]) return CODE_PUNCT[c];
  if (e.key === "+") return "+";
  return null;
}
/** The canonical text of a key press ("Ctrl+Shift+M"), or null for a modifier alone / a key without a name. On macOS
 *  ⌘ reads as Ctrl and Control as Meta — Qt's convention, so "Ctrl+K" is ⌘K there like the registered shortcuts. */
export function eventChordText(e: KeyboardEvent): string | null {
  const k = eventKeyName(e);
  if (k === null || k === "Ctrl" || k === "Alt" || k === "Shift" || k === "Meta") return null;
  const ctrl = isMac ? e.metaKey : e.ctrlKey;
  const meta = isMac ? e.ctrlKey : e.metaKey;
  const parts: string[] = [];
  if (ctrl) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (meta) parts.push("Meta");
  parts.push(k);
  return parts.join("+");
}
type ActionKeyHook = (e: KeyboardEvent, text: string, typing: boolean) => boolean;
let actionKeyHook: ActionKeyHook | null = null;
let defaultLiveCheck: ((action: string, registered: string) => boolean) | null = null;
let suspended = 0;
/** A person's own keys run first (true = handled: the key is consumed). */
export function setActionKeyHook(fn: ActionKeyHook | null): void {
  actionKeyHook = fn;
}
/** Whether a registered default key still belongs to its `action` on this device — asked with the key as the feature
 *  registered it ("Ctrl+Shift+M"), never with the press's own name (a layout may name the press differently). */
export function setDefaultLiveCheck(fn: ((action: string, registered: string) => boolean) | null): void {
  defaultLiveCheck = fn;
}
/** While a key is being recorded (Settings → Shortcuts), no shortcut fires. Returns the release. */
export function suspendShortcuts(): () => void {
  suspended++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    suspended--;
  };
}

export function registerShortcut(def: ShortcutDef): () => void {
  const keys = Array.isArray(def.keys) ? def.keys : [def.keys];
  const entry: Entry = { def, parsed: keys.map(parseSequence), keys, seq: ++seqCounter };
  entries.set(def.id, entry);
  return () => {
    if (entries.get(def.id) === entry) entries.delete(def.id);
  };
}

function onKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing || suspended > 0) return;
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
  const typing = isTyping(e);
  const text = eventChordText(e);
  if (text !== null && actionKeyHook && actionKeyHook(e, text, typing)) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const list = [...entries.values()].sort(
    (a, b) => (b.def.priority ?? 0) - (a.def.priority ?? 0) || b.seq - a.seq,
  );
  for (const en of list) {
    if (typing && !en.def.whenTyping) continue;
    const mi = en.parsed.findIndex((p) => matches(p, e));
    if (mi < 0) continue;
    // a default key runs only while it still belongs to its action here (Settings → Shortcuts may have moved it)
    if (en.def.action && defaultLiveCheck && !defaultLiveCheck(en.def.action, en.keys[mi])) continue;
    if (en.def.enabled && !en.def.enabled()) continue;
    let handled: boolean | void;
    try {
      handled = en.def.run(e);
    } catch (err) {
      console.error(`[shortcuts] ${en.def.id} threw`, err);
      handled = true;
    }
    if (handled !== false) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  }
}

let installed = false;

/**
 * Install the window keydown listener (idempotent). The app calls it once at boot; useShortcut
 * also calls it. `r.shortcuts` registry items are bridged in by registry.ts.
 */
export function installShortcuts(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", onKeyDown, true);
}

/** React: a shortcut active while the component is mounted (and `enabled`). */
export function useShortcut(
  keys: string | string[],
  run: (e: KeyboardEvent) => boolean | void,
  opts: { enabled?: boolean; whenTyping?: boolean; priority?: number; id?: string; action?: string } = {},
): void {
  const runRef = useRef(run);
  runRef.current = run;
  const enabled = opts.enabled ?? true;
  const keyStr = Array.isArray(keys) ? keys.join("|") : keys;
  useEffect(() => {
    installShortcuts();
    if (!enabled) return;
    const id = opts.id ?? `use:${keyStr}:${++seqCounter}`;
    return registerShortcut({
      id,
      keys: keyStr.split("|"),
      run: (e) => runRef.current(e),
      whenTyping: opts.whenTyping,
      priority: opts.priority,
      action: opts.action,
    });
  }, [enabled, keyStr, opts.whenTyping, opts.priority, opts.id, opts.action]);
}

/** Human label for a sequence in the platform's style ("Ctrl+K" / "⌘K"). */
export function shortcutLabel(seq: string): string {
  if (!isMac) return seq;
  return seq.replace(/Ctrl\+/g, "⌘").replace(/Shift\+/g, "⇧").replace(/Alt\+/g, "⌥");
}
