// Button.tsx — the push buttons.
//   Button          ThButton.qml    — the house push button (34 px, radius 8, panelHi fill)
//   BasicButton     Controls.Button   — Qt Quick Controls Basic look (40 px, palette.button)
//   ToolButton      ThToolButton.qml — Basic ToolButton chrome + an icon-pack glyph (+ label)
//   BasicToolButton Controls.ToolButton with icon.name/text (the style's own IconLabel, 24 px icon)
// All accept `tip` (Controls.ToolTip, 400 ms) and `force` (gallery: pin hover/pressed/focus).
import { forwardRef, useRef, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import { Icon } from "./Icon";
import { useTip } from "./Tooltip";
import { cx, mergeRefs, useHoverPress, type ForceState } from "./hooks";
import s from "./Button.module.css";

type Native = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "children">;

export interface ButtonProps extends Native {
  text?: string;
  /** icon-pack name (drawn 16 px through ThIcon) */
  icon?: string;
  /** accent fill (the stock `highlighted`) */
  highlighted?: boolean;
  /** transparent, accentBright text */
  flat?: boolean;
  /** red fill (destructive) */
  danger?: boolean;
  radius?: number;
  tip?: string;
  force?: ForceState;
  type?: "button" | "submit";
  children?: ReactNode;
}

/** ThButton */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { text, icon, highlighted, flat, danger, radius, tip, force, type = "button", className, style, disabled, children, ...rest },
  ref,
) {
  const own = useRef<HTMLButtonElement>(null);
  useTip(own, tip);
  const hp = useHoverPress(disabled);
  const kind = danger ? s.danger : highlighted ? s.highlighted : flat ? s.flat : s.plain;
  const st: CSSProperties = radius !== undefined ? { ...style, borderRadius: radius } : style ?? {};
  return (
    <button
      ref={mergeRefs(ref, own)}
      type={type}
      className={cx(s.th, kind, className)}
      style={st}
      disabled={disabled}
      data-force={force}
      {...hp.handlers}
      {...rest}
    >
      {icon && (
        <Icon
          name={icon}
          size={16}
          color={danger ? "var(--th-button-danger-fg)" : highlighted ? "var(--th-button-primary-fg)" : flat ? "var(--th-button-ghost-fg)" : "var(--th-button-secondary-fg)"}
          hovered={hp.hovered || force === "hover"}
          disabled={disabled}
        />
      )}
      {text !== undefined && <span className={s.label}>{text}</span>}
      {children}
    </button>
  );
});

export interface BasicButtonProps extends Native {
  text?: string;
  icon?: string;
  /** Controls.Button `flat` */
  flat?: boolean;
  highlighted?: boolean;
  checked?: boolean;
  tip?: string;
  force?: ForceState;
  type?: "button" | "submit";
  children?: ReactNode;
}

/** Controls.Button (Basic style, the app palette): 100×40 implicit, padding 6/8, palette.button. */
export const BasicButton = forwardRef<HTMLButtonElement, BasicButtonProps>(function BasicButton(
  { text, icon, flat, highlighted, checked, tip, force, type = "button", className, disabled, children, ...rest },
  ref,
) {
  const own = useRef<HTMLButtonElement>(null);
  useTip(own, tip);
  const hp = useHoverPress(disabled);
  return (
    <button
      ref={mergeRefs(ref, own)}
      type={type}
      className={cx(s.basic, flat && s.basicFlat, (checked || highlighted) && s.basicOn, className)}
      disabled={disabled}
      data-force={force}
      aria-pressed={checked}
      {...hp.handlers}
      {...rest}
    >
      {icon && <Icon name={icon} size={24} color="currentColor" staticOnly />}
      {text !== undefined && <span className={s.label}>{text}</span>}
      {children}
    </button>
  );
});

export interface ToolButtonProps extends Native {
  /** icon-pack name */
  iconName?: string;
  /** optional bold label beside the glyph */
  label?: string;
  tip?: string;
  /** holds the story's end pose (like checked) */
  active?: boolean;
  checked?: boolean;
  iconColor?: string;
  /** Kirigami.Units.iconSizes.smallMedium (22) by default */
  iconSize?: number;
  force?: ForceState;
  type?: "button" | "submit";
  children?: ReactNode;
}

/** ThToolButton — Basic ToolButton background (40×40, palette.button at 0.5) + ThIcon. */
export const ToolButton = forwardRef<HTMLButtonElement, ToolButtonProps>(function ToolButton(
  { iconName, label, tip, active, checked, iconColor, iconSize = 22, force, type = "button", className, disabled, children, ...rest },
  ref,
) {
  const own = useRef<HTMLButtonElement>(null);
  useTip(own, tip);
  const hp = useHoverPress(disabled);
  return (
    <button
      ref={mergeRefs(ref, own)}
      type={type}
      className={cx(s.tool, checked && s.toolOn, className)}
      disabled={disabled}
      data-force={force}
      aria-label={tip || label}
      aria-pressed={checked}
      {...hp.handlers}
      {...rest}
    >
      {iconName && (
        <Icon
          name={iconName}
          size={iconSize}
          color={iconColor ?? "var(--th-button-tool-fg)"}
          hovered={hp.hovered || force === "hover"}
          active={active || checked}
          disabled={disabled}
        />
      )}
      {label && (
        <span className={s.toolLabel} style={{ color: iconColor ?? "var(--th-button-tool-fg)" }}>
          {label}
        </span>
      )}
      {children}
    </button>
  );
});

export interface BasicToolButtonProps extends Native {
  iconName?: string;
  text?: string;
  /** Controls.AbstractButton.display */
  display?: "iconOnly" | "textOnly" | "textBesideIcon";
  tip?: string;
  checked?: boolean;
  force?: ForceState;
  type?: "button" | "submit";
  children?: ReactNode;
}

/** Controls.ToolButton with the style's own IconLabel (24 px icon, 12 px text). */
export const BasicToolButton = forwardRef<HTMLButtonElement, BasicToolButtonProps>(function BasicToolButton(
  { iconName, text, display = "textBesideIcon", tip, checked, force, type = "button", className, disabled, children, ...rest },
  ref,
) {
  const own = useRef<HTMLButtonElement>(null);
  useTip(own, tip);
  const hp = useHoverPress(disabled);
  const showIcon = !!iconName && display !== "textOnly";
  const showText = !!text && display !== "iconOnly";
  return (
    <button
      ref={mergeRefs(ref, own)}
      type={type}
      className={cx(s.tool, s.basicTool, checked && s.toolOn, className)}
      disabled={disabled}
      data-force={force}
      aria-label={tip || text}
      aria-pressed={checked}
      {...hp.handlers}
      {...rest}
    >
      {showIcon && <Icon name={iconName!} size={24} color="var(--th-button-tool-fg)" staticOnly />}
      {showText && <span className={s.label}>{text}</span>}
      {children}
    </button>
  );
});
