// touchPress.ts — while a finger is down on something with a long-press menu, no text on the page is selectable, so
// iOS can't start its own selection (and its Copy / Look Up bar) next to the menu the press opens: on an iPad a
// message's menu opens under the finger and iOS selected text beside it (verify pass, 2026-10-25). Typed text keeps
// its own selection (tokens.css). Ends when the finger lifts or the press is cancelled, after 3 s at the latest.

const ENDS = ["pointerup", "pointercancel", "touchend", "touchcancel"] as const;
let timer = 0;

function end(): void {
  delete document.documentElement.dataset.pressing;
  window.clearTimeout(timer);
  for (const t of ENDS) document.removeEventListener(t, end, true);
}

/** Call from a touch pointerdown that may become a long-press. */
export function holdTextSelection(): void {
  end();
  document.documentElement.dataset.pressing = "";
  for (const t of ENDS) document.addEventListener(t, end, true);
  timer = window.setTimeout(end, 3000);
}
