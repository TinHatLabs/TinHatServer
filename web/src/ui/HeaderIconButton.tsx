// HeaderIconButton.tsx — HeaderIconButton.qml: the round, flat room-header button.
// size gridUnit×2 (36); hover: a soft accentBright wash (0.18, 0.30 pressed) inset 2 px, a 2 px
// accentBright glow ring 1 px outside at 0.35, the 22 px glyph scales 1.16 and tilts −3° with an
// OutBack ease; `accent` tints the glyph accentBright and holds its story (active call, open panel).
import { forwardRef, useRef, type ButtonHTMLAttributes } from "react";
import { Icon } from "./Icon";
import { useTip } from "./Tooltip";
import { cx, mergeRefs, useHoverPress, type ForceState } from "./hooks";
import s from "./HeaderIconButton.module.css";

export interface HeaderIconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  iconName: string;
  tip?: string;
  accent?: boolean;
  /** px; default Kirigami.Units.gridUnit * 2 */
  size?: number;
  force?: ForceState;
}

export const HeaderIconButton = forwardRef<HTMLButtonElement, HeaderIconButtonProps>(function HeaderIconButton(
  { iconName, tip, accent, size = 36, force, className, style, disabled, ...rest },
  ref,
) {
  const own = useRef<HTMLButtonElement>(null);
  useTip(own, tip);
  const hp = useHoverPress(disabled);
  const hovered = hp.hovered || force === "hover" || force === "pressed";
  return (
    <button
      ref={mergeRefs(ref, own)}
      type="button"
      className={cx(s.btn, hovered && s.hovered, (hp.pressed || force === "pressed") && s.pressed, className)}
      style={{ width: size, height: size, ...style }}
      disabled={disabled}
      data-force={force}
      aria-label={tip}
      {...hp.handlers}
      {...rest}
    >
      <span className={s.wash} />
      <span className={s.ring} />
      <span className={s.focus} />
      <span className={s.glyph}>
        <Icon
          name={iconName}
          size={22}
          color={accent ? "var(--th-button-icon-icon-active)" : "var(--th-button-icon-icon)"}
          hovered={hovered}
          active={accent}
          disabled={disabled}
        />
      </span>
    </button>
  );
});
