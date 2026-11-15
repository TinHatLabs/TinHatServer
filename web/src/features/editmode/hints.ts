// hints.ts — A17.2: the edit-layout words name the key layout.edit has NOW (a person can rebind it in Settings →
// Shortcuts, or have none). The desktop's LayoutSection.qml + EditToolbar.qml build the same words.
/** Settings → Appearance → Layout → Edit layout's description. */
export function editLayoutHint(key: string | undefined): string {
  return key
    ? `Move, resize and add islands. ${key} or right-clicking a gap between islands opens it.`
    : "Move, resize and add islands. Right-clicking a gap between islands opens it.";
}

/** The edit toolbar's Done tip. */
export function doneTip(dirty: boolean, key: string | undefined): string {
  const base = dirty ? "Save and close" : "Close";
  return key ? `${base} (${key})` : base;
}

/** A17.0: hiding or removing an island says so (it went silently); Undo brings it back. The desktop's EditMode.qml: the
 *  same words. */
export function hiddenWords(name: string): string {
  return `${name} hidden — Undo brings it back.`;
}
export const REMOVED_WORDS = "Button island removed — Undo brings it back.";
