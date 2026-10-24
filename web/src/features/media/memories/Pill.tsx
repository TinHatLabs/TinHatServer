// Pill.tsx — MemoriesWindow.qml's local `Pill`: radius h/2, padding 7×3, smallFont label,
// default fg textDim on panelHi.
import type { CSSProperties } from "react";
import s from "./Memories.module.css";

export function Pill({ text, fg, bg, bold, style, className }: { text: string; fg?: string; bg?: string; bold?: boolean; style?: CSSProperties; className?: string }) {
  return (
    <span className={`${s.pill} ${className ?? ""}`} style={{ color: fg ?? "var(--th-memories-pill-fg)", background: bg ?? "var(--th-memories-pill-bg)", fontWeight: bold ? 700 : 400, ...style }}>
      {text}
    </span>
  );
}
