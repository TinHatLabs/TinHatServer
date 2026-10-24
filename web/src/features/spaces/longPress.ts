// longPress.ts — touch long-press = right-click for the member rows (ARCHITECTURE "Mobile layout
// rules"). 500 ms like the foundation's ContextMenu; cancelled by lifting the finger or moving
// > 10 px; the click that follows a long-press is swallowed so the row doesn't also open the profile.
import { useRef, type PointerEvent as RPointerEvent, type MouseEvent as RMouseEvent } from "react";

/**
 * The click that ends a long-press lands on whatever is under the finger by then — usually the
 * menu sheet that just opened. Swallow that one click (capture phase, ≤ 1 s).
 */
function swallowNextClick() {
  const kill = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    done();
  };
  const done = () => {
    document.removeEventListener("click", kill, true);
    window.clearTimeout(t);
  };
  const t = window.setTimeout(done, 1000);
  document.addEventListener("click", kill, true);
}

export function useLongPress(onLongPress: (pt: { x: number; y: number }) => void, delay = 500) {
  const st = useRef<{ t: number; x: number; y: number; fired: boolean }>({ t: 0, x: 0, y: 0, fired: false });
  const clear = () => {
    window.clearTimeout(st.current.t);
    st.current.t = 0;
  };
  return {
    onPointerDown: (e: RPointerEvent) => {
      if (e.pointerType !== "touch") return;
      clear();
      const x = e.clientX, y = e.clientY;
      st.current = {
        x,
        y,
        fired: false,
        t: window.setTimeout(() => {
          st.current.fired = true;
          swallowNextClick();
          onLongPress({ x, y });
        }, delay),
      };
    },
    onPointerMove: (e: RPointerEvent) => {
      if (st.current.t && Math.hypot(e.clientX - st.current.x, e.clientY - st.current.y) > 10) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    /** wrap the row's onClick: ignores the click that ends a long-press */
    guardClick:
      (f: (e: RMouseEvent) => void) =>
      (e: RMouseEvent): void => {
        if (st.current.fired) {
          st.current.fired = false;
          return;
        }
        f(e);
      },
  };
}
