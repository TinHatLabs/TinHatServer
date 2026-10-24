// PickOverlay.tsx — THEMES-UI.md §15.3: while Pick is armed a transparent catcher covers the app (below the editor
// panel): the pointer is a crosshair, the element under it gets the outline (moved only when the pointer reaches
// another element — nothing is drawn per frame), a click samples (pick.ts) and shows the "Picked" group in Advanced.
// Esc disarms. Phones: a tap picks.
import { useEffect, useRef, useState } from "react";
import { showToast } from "@/ui";
import { useEditor } from "./editorStore";
import { chainAt, pickAt } from "./pick";
import s from "./editor.module.css";

export function togglePick(): void {
  const st = useEditor.getState();
  if (!st.open) return;
  useEditor.setState({ pickArmed: !st.pickArmed });
}

function editorParts(): Element[] {
  return [...document.querySelectorAll('[aria-label="Edit theme"][role="dialog"], [data-pick-ui]')];
}

export function PickOverlay() {
  const catcher = useRef<HTMLDivElement>(null);
  const outline = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const last = useRef<Element | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        useEditor.setState({ pickArmed: false });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const exclude = (): Element[] => [...editorParts(), ...(catcher.current ? [catcher.current] : []), ...(outline.current ? [outline.current] : [])];
  const hover = (x: number, y: number) => {
    const el = chainAt(x, y, exclude())[0] ?? null;
    if (el === last.current) return;
    last.current = el;
    setRect(el ? el.getBoundingClientRect() : null);
  };
  return (
    <>
      <div
        ref={catcher}
        className={s.pickCatcher}
        data-pick-ui=""
        onPointerMove={(e) => hover(e.clientX, e.clientY)}
        onPointerLeave={() => {
          last.current = null;
          setRect(null);
        }}
        onClick={(e) => {
          const list = pickAt(e.clientX, e.clientY, exclude());
          useEditor.setState({ pickArmed: false, picked: list.length ? list : null, mode: list.length ? "advanced" : useEditor.getState().mode, query: "", changedOnly: false });
          if (!list.length) showToast("No named colours there.", "short");
        }}
        onContextMenu={(e) => e.preventDefault()}
      />
      {rect && <div ref={outline} className={s.pickOutline} data-pick-ui="" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />}
    </>
  );
}
