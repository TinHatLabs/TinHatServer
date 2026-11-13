// pttChord.ts — push to talk's key rules (launch-gate 2026-11-07; shared vectors testvectors/ptt-key.json = the desktop's
// ptt_rules.rs). A modifier on its own (Ctrl by default) doesn't start a hold while a text field has focus: it is the start
// of a shortcut there, and Ctrl+C must transmit nothing. And any other key pressed during a modifier's hold ends it. A
// non-modifier binding (an F-key) works everywhere: you can type while holding it.
const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta", "Super"];

export function pressStartsHold(key: string, textFocus: boolean): boolean {
  return !(textFocus && MODIFIERS.includes(key));
}

export function chordEndsHold(heldKey: string | null, pressedIsPttKey: boolean, repeat: boolean): boolean {
  return heldKey !== null && MODIFIERS.includes(heldKey) && !pressedIsPttKey && !repeat;
}

const NOT_TEXT_INPUTS = ["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image"];

/** A field the person types into has the keyboard (the desktop's _pttTextFocus). */
export function pttTextFocus(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  return el instanceof HTMLInputElement && !el.readOnly && !NOT_TEXT_INPUTS.includes(el.type);
}
