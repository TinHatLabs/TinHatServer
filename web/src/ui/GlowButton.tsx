// GlowButton.tsx — GlowButton.qml, the ONE primary call-to-action per surface (Sign in, Send,
// Save, Join…). Padding padLg/pad (12/8), bold label in onAccent, centred; the accent pill lifts
// 2 px on hover (only the pill + glow move, the label stays), lighter ×1.12 on hover, darker ×1.12
// pressed; glow = the web fork's box-shadow (rest 0 2 12 accent .35, hover 0 4 18 accent .55);
// 2 px accentBright ring on keyboard focus; `busy` swaps the label for the spinner; Enter clicks.
import { forwardRef, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon } from "./Icon";
import { BusyIndicator } from "./BusyIndicator";
import { useTip } from "./Tooltip";
import { cx, mergeRefs, type ForceState } from "./hooks";
import s from "./GlowButton.module.css";

export interface GlowButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "children"> {
  text?: string;
  icon?: string;
  busy?: boolean;
  tip?: string;
  force?: ForceState;
  type?: "button" | "submit";
  children?: ReactNode;
}

export const GlowButton = forwardRef<HTMLButtonElement, GlowButtonProps>(function GlowButton(
  { text, icon, busy, tip, force, type = "button", className, disabled, onClick, onKeyDown, children, ...rest },
  ref,
) {
  const own = useRef<HTMLButtonElement>(null);
  useTip(own, tip);
  return (
    <button
      ref={mergeRefs(ref, own)}
      type={type}
      className={cx(s.glow, className)}
      disabled={disabled}
      data-force={force}
      aria-busy={busy || undefined}
      onClick={(e) => {
        if (busy) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.key === "Enter" && !busy && !disabled && !e.defaultPrevented && type !== "submit") {
          e.preventDefault();
          e.currentTarget.click();
        }
      }}
      {...rest}
    >
      <span className={s.pill} aria-hidden />
      {busy ? (
        <span className={s.content}>
          <BusyIndicator size={25} />
        </span>
      ) : (
        <span className={s.content}>
          {icon && <Icon name={icon} size={16} color="var(--th-button-cta-fg)" />}
          {text !== undefined && <span className={s.label}>{text}</span>}
          {children}
        </span>
      )}
    </button>
  );
});
