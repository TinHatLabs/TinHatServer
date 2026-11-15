// threads/focusIntent.ts — 12.1.16 round 4 (G-threads T3): a notification's Reply that targets a THREAD must end with
// the keyboard in that thread's composer and keep it there. The room's main view mounts a moment after the thread panel
// and its autofocus used to take the keyboard, so the reply went out in the main timeline with no relation.
// A "focus intent": while a thread Reply is pending, nothing may focus the room's MAIN composer programmatically (its
// mount autofocus, a focus retry); only the person can, by clicking or tabbing there, which ends the intent. Ends too on
// a newer Reply, or after INTENT_MS. Pure, no app imports (focusIntent.test.ts).

export const INTENT_MS = 60_000;

let intent: { roomId: string; root: string; until: number } | null = null;

/** A Reply asked for `root`'s composer in `roomId`. */
export function holdMainFocusFor(roomId: string, root: string, now = Date.now(), ms = INTENT_MS): void {
  intent = { roomId, root, until: now + ms };
}

/** The person acted (a click, Tab), or another Reply / navigation took over. */
export function releaseMainFocus(): void {
  intent = null;
}

/** The thread a pending Reply wants the keyboard in for `roomId` ("" = none): the main composer must not take focus. */
export function heldForThread(roomId: string, now = Date.now()): string {
  if (!intent || intent.roomId !== roomId) return "";
  if (now > intent.until) {
    intent = null;
    return "";
  }
  return intent.root;
}

/** May the room's main composer take the keyboard programmatically now? */
export function mainFocusHeld(roomId: string, now = Date.now()): boolean {
  return heldForThread(roomId, now) !== "";
}
