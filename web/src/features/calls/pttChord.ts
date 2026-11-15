// pttChord.ts — push to talk's key rules (launch-gate 2026-11-07; shared vectors testvectors/ptt-key.json = the desktop's
// ptt_rules.rs). A modifier on its own (Ctrl by default) doesn't start a hold while a text field has focus: it is the start
// of a shortcut there, and Ctrl+C must transmit nothing. And any other key pressed during a modifier's hold ends it. A
// non-modifier binding (an F-key) works everywhere: you can type while holding it.
const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta", "Super"];

export function pressStartsHold(key: string, textFocus: boolean): boolean {
  return !(textFocus && MODIFIERS.includes(key));
}

/** 4-1 (2026-11-14; the desktop's ptt_rules::press_starts, vectors `pressExact`): the press rule with the whole event —
 *  no OTHER modifier held (Shift+F10 is the menu key, not an F10 hold; Shift+Ctrl is a chord) and nothing handled the
 *  press already (defaultPrevented). */
export function pressStarts(key: string, otherMods: boolean, handled: boolean, textFocus: boolean): boolean {
  return !otherMods && !handled && pressStartsHold(key, textFocus);
}

/** 4-2 (2026-11-14; the desktop's ptt_rules::press_starts_in, vectors `pressPopup`): no press starts a hold while a
 *  dialog, menu or other popup owns the keyboard focus (a Ctrl in "Send as text?" or a keyboard menu transmitted). */
export function pressStartsIn(key: string, popup: boolean, otherMods: boolean, handled: boolean, textFocus: boolean): boolean {
  return !popup && pressStarts(key, otherMods, handled, textFocus);
}

const POPUPS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="menubar"], [role="listbox"], [aria-modal="true"], dialog[open]';
/** A dialog, menu or popup owns the keyboard focus (the desktop's _pttPopupFocus). */
export function pttPopupFocus(): boolean {
  const el = document.activeElement;
  return el instanceof Element && el.closest(POPUPS) !== null;
}

/** A modifier held besides the key itself (the key's own modifier doesn't count). */
export function otherModifiers(e: KeyboardEvent, key: string): boolean {
  return (e.ctrlKey && key !== "Ctrl") || (e.shiftKey && key !== "Shift") || (e.altKey && key !== "Alt") || (e.metaKey && key !== "Meta" && key !== "Super")
    // 12.1.16 (4-1, review round): AltGr is a modifier of its own on some layouts (not reported as Ctrl / Alt)
    || (typeof e.getModifierState === "function" && e.getModifierState("AltGraph"));
}

export function chordEndsHold(heldKey: string | null, pressedIsPttKey: boolean, repeat: boolean): boolean {
  return heldKey !== null && MODIFIERS.includes(heldKey) && !pressedIsPttKey && !repeat;
}

/** BRB privacy (2026-11-13; the desktop's ptt_rules::hold_speaks): a press while I am away never opens the mic. */
export function holdSpeaks(down: boolean, away: boolean): boolean {
  return down && !away;
}

/** A22.1 (2026-11-13; the desktop's ptt_rules::muted_hint): the "you're muted" bubble under push to talk. A modifier on
 *  its own does nothing while a text field has focus, so its hint says so. */
export function mutedHint(key: string): string {
  return MODIFIERS.includes(key) ? `You're muted — hold ${key} to talk (click outside the message box first)` : `You're muted — hold ${key} to talk`;
}

/** P15 (2026-11-13; the desktop's ptt_rules RELEASE_TAIL_MS): a release keeps the mic open this long so the last word
 *  isn't cut (no setting); a press in that time continues the hold. While I am away the release is immediate. */
export const RELEASE_TAIL_MS = 250;
export function releaseTailMs(away: boolean): number {
  return away ? 0 : RELEASE_TAIL_MS;
}

/**
 * The mic's wanted state with push to talk in the picture (the desktop's ptt_rules::target_muted). With push to talk ON
 * the mic is muted unless the key is held and I am not away, whatever the mute button says; with it OFF the mute button
 * decides (BRB mutes through it, and someone who unmutes by hand while away owns that).
 */
export function pttTargetMuted(pttOn: boolean, holding: boolean, manualMuted: boolean, away: boolean): boolean {
  return pttOn ? away || !holding : manualMuted;
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
