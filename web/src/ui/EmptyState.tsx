// EmptyState.tsx — EmptyState.qml: a centred column (width min(parent − 4 gridUnits, 22 gridUnits),
// spacing 8): a 128 px illustration box with a 1.15× "glow disc" (vertical gradient accent →
// transparent at 0.18), a 64 px textDim icon at 0.85 (or a 48 px busy indicator), a level-2
// heading and a dim explanation, both centred and wrapped.
import type { CSSProperties, ReactNode } from "react";
import { Icon } from "./Icon";
import { BusyIndicator } from "./BusyIndicator";
import s from "./EmptyState.module.css";

export interface EmptyStateProps {
  loading?: boolean;
  iconName?: string;
  title?: string;
  explanation?: ReactNode;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function EmptyState({ loading, iconName = "documentinfo-symbolic", title, explanation, className, style, children }: EmptyStateProps) {
  return (
    <div className={`${s.wrap} ${className ?? ""}`} style={style}>
      <div className={s.col}>
        <div className={s.art}>
          <span className={s.glow} />
          {loading ? <BusyIndicator size={48} /> : <Icon name={iconName} size={64} color="var(--th-empty-icon)" opacity={0.85} />}
        </div>
        {title && <div className={s.title}>{title}</div>}
        {explanation && <div className={s.expl}>{explanation}</div>}
        {children}
      </div>
    </div>
  );
}
