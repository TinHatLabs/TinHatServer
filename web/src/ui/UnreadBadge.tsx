// UnreadBadge.tsx — UnreadBadge.qml, the ONE unread/mention badge: height round(gridUnit × 0.95)
// = 17, width max(17, label + 2 × smallSpacing), pill radius; accent fill, danger when
// `highlight` (mention / DM); bold onAccent count at round(17 × 0.62) = 11 px, capped "99+".
import type { CSSProperties } from "react";
import s from "./UnreadBadge.module.css";

export function UnreadBadge({ count, highlight, className, style }: { count: number; highlight?: boolean; className?: string; style?: CSSProperties }) {
  if (!(count > 0)) return null;
  return (
    <span className={`${s.badge} ${highlight ? s.hl : ""} ${className ?? ""}`} style={style} aria-label={`${count} unread`}>
      {count > 99 ? "99+" : count}
    </span>
  );
}
