// Label.tsx — text primitives.
//   Label         Controls.Label (12 px windowText)
//   Heading       Kirigami.Heading level 1..5 (defaultFont × 1.35/1.20/1.15/1.10/1.0, weight Normal)
//   SectionLabel  SectionLabel.qml: bold, textDim, smallFont, letter-spacing 0.4
//   HintLabel     HintLabel.qml: textDim, smallFont, wraps
//   Separator     Kirigami.Separator: 1 px, bg→text interpolated at frameContrast 0.2
import type { CSSProperties, ElementType, HTMLAttributes, ReactNode } from "react";
import { cx } from "./hooks";
import s from "./Label.module.css";

type P = HTMLAttributes<HTMLElement> & { children?: ReactNode; as?: ElementType; style?: CSSProperties; className?: string };

export function Label({ as: As = "span", className, dim, small, bold, elide, wrap, ...rest }: P & { dim?: boolean; small?: boolean; bold?: boolean; elide?: boolean; wrap?: boolean }) {
  return <As className={cx(s.label, dim && s.dim, small && s.small, bold && s.bold, elide && s.elide, wrap && s.wrap, className)} {...rest} />;
}

export function Heading({ level = 1, as, className, ...rest }: P & { level?: 1 | 2 | 3 | 4 | 5 }) {
  const As = as ?? (`h${Math.min(level, 5) + 0}` as ElementType);
  return <As className={cx(s.heading, s[`h${level}`], className)} {...rest} />;
}

export function SectionLabel({ as: As = "div", className, ...rest }: P) {
  return <As className={cx(s.section, className)} {...rest} />;
}

export function HintLabel({ as: As = "div", className, ...rest }: P) {
  return <As className={cx(s.hint, className)} {...rest} />;
}

export function Separator({ vertical, className, style }: { vertical?: boolean; className?: string; style?: CSSProperties }) {
  return <div role="separator" aria-orientation={vertical ? "vertical" : "horizontal"} className={cx(vertical ? s.vsep : s.hsep, className)} style={style} />;
}
