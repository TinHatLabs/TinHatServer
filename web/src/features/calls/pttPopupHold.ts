// pttPopupHold.ts — 12.1.16 fix round (review round on 4-2): which focus ends a push-to-talk key hold: a dialog, menu or
// popup that takes the keyboard — a menu or listbox, a modal, or a floating dialog / window (role dialog / alertdialog:
// Settings, the calendar, popovers). NOT an inline card that carries role="dialog" (data-inline-card: the tour offer in
// the room list) and not a toast's button: focusing those must not cut the person off mid-word.
export function pttPopupOpened(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement;
  if (!(el instanceof Element)) return false;
  const pop = el.closest('[role="menu"], [role="listbox"], [aria-modal="true"], [role="dialog"], [role="alertdialog"]');
  return !!pop && !pop.hasAttribute("data-inline-card");
}
