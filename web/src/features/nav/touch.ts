// touch.ts — long-press = right-click on phones. After a long-press opens a menu (a bottom sheet on
// phones), the finger lift must not "click" whatever now lies under it (the sheet's row, or the
// room/space itself): swallow the next click anywhere for a short while.
export function swallowNextClick(ms = 700): void {
  const kill = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.removeEventListener("click", kill, true);
  };
  window.addEventListener("click", kill, true);
  window.setTimeout(() => window.removeEventListener("click", kill, true), ms);
}
