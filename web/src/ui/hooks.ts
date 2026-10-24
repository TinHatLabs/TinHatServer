// hooks.ts — small shared hooks for the primitives.
import { useCallback, useRef, useState, type PointerEvent as RPointerEvent } from "react";

/** Hover + press tracking (the icon stories need `hovered` as state, not just :hover CSS). */
export function useHoverPress(disabled?: boolean) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const onPointerEnter = useCallback(
    (e: RPointerEvent) => {
      if (e.pointerType !== "touch") setHovered(true);
    },
    [],
  );
  const onPointerLeave = useCallback(() => {
    setHovered(false);
    setPressed(false);
  }, []);
  const onPointerDown = useCallback(
    (e: RPointerEvent) => {
      if (e.button === 0) setPressed(true);
    },
    [],
  );
  const onPointerUp = useCallback(() => setPressed(false), []);
  return {
    hovered: hovered && !disabled,
    pressed: pressed && !disabled,
    handlers: { onPointerEnter, onPointerLeave, onPointerDown, onPointerUp, onPointerCancel: onPointerUp },
  };
}

/** Merge several refs into one callback ref. */
export function mergeRefs<T>(...refs: Array<React.Ref<T> | undefined>): React.RefCallback<T> {
  return (v: T | null) => {
    for (const r of refs) {
      if (!r) continue;
      if (typeof r === "function") r(v);
      else (r as React.RefObject<T | null>).current = v;
    }
  };
}

/** Stable callback ref that always calls the latest function. */
export function useLatest<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

/** "Force" a visual state in the gallery: data-force="hover|pressed|focus". */
export type ForceState = "hover" | "pressed" | "focus" | undefined;

export function cx(...c: Array<string | false | null | undefined>): string {
  return c.filter(Boolean).join(" ");
}
