// CallRoundButton.tsx — a faithful copy of Main.qml's `CallButton` (50×50 round call-bar button),
// used for the soundboard's call-bar button. callui owns the call bar; if it exports its own
// CallButton, integration may swap this for it (same props).
import { useRef, type ButtonHTMLAttributes } from "react";
import { Icon, useHoverPress, useTip, cx } from "@/ui";
import s from "./CallRoundButton.module.css";

export interface CallRoundButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  iconName: string;
  tip?: string;
  active?: boolean;
  danger?: boolean;
  /** `live` = false → 50 % opacity but hover (tooltip) survives */
  live?: boolean;
}

export function CallRoundButton({ iconName, tip, active, danger, live = true, className, onClick, ...rest }: CallRoundButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  useTip(ref, tip);
  const hp = useHoverPress(!live);
  return (
    <button
      ref={ref}
      type="button"
      className={cx(s.btn, active && s.active, danger && s.danger, !live && s.dead, className)}
      aria-label={tip}
      aria-pressed={active}
      onClick={(e) => live && onClick?.(e)}
      {...hp.handlers}
      {...rest}
    >
      <span className={s.glyph}>
        <Icon
          name={iconName}
          size={22}
          color={active || danger ? "var(--th-callbar-button-icon)" : "var(--th-callbar-button-icon-off)"}
          hovered={hp.hovered && live}
          active={active}
        />
      </span>
    </button>
  );
}
