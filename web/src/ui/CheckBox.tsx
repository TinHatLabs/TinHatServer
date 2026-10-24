// CheckBox.tsx — check boxes, radio buttons, switches.
//   CheckBox        ThCheckBox.qml   20 px rounded square (radius 5): bg → panelHi on hover,
//                                      accent fill + a drawn onAccent tick when checked
//   RadioButton     ThRadioButton.qml 20 px circle, a 10 px accentBright dot springs in (OutBack)
//   BasicCheckBox   Controls.CheckBox  28 px square, palette.base, 1 px palette.mid, Qt's tick
//   BasicRadioButton Controls.RadioButton 28 px circle, a 20 px palette.text dot
//   Switch          Controls.Switch    Basic: 56×28 indicator, 16 px track (radius 8) —
//                                      midlight off / palette.dark on — and a 28 px knob
import { useId, type CSSProperties, type InputHTMLAttributes, type ReactNode } from "react";
import { cx, type ForceState } from "./hooks";
import s from "./CheckBox.module.css";

interface BaseProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange" | "checked" | "onToggle"> {
  text?: ReactNode;
  checked?: boolean;
  /** Qt `toggled` — the new checked state */
  onToggled?: (checked: boolean) => void;
  force?: ForceState;
  className?: string;
  style?: CSSProperties;
  /** label colour (ThCheckBox.labelColor) */
  labelColor?: string;
}

function Base({
  kind,
  text,
  checked,
  onToggled,
  force,
  className,
  style,
  labelColor,
  disabled,
  indicator,
  role,
  ...rest
}: BaseProps & { kind: string; indicator: ReactNode; role?: "checkbox" | "radio" | "switch" }) {
  const id = useId();
  return (
    <label className={cx(s.row, kind, checked && s.checked, disabled && s.disabled, className)} style={style} data-force={force} htmlFor={id}>
      <input
        id={id}
        type={role === "radio" ? "radio" : "checkbox"}
        role={role === "switch" ? "switch" : undefined}
        className={s.input}
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onToggled?.(e.target.checked)}
        {...rest}
      />
      {indicator}
      {text !== undefined && text !== "" && (
        <span className={s.text} style={labelColor && !disabled ? { color: labelColor } : undefined}>
          {text}
        </span>
      )}
    </label>
  );
}

/** ThCheckBox */
export function CheckBox(p: BaseProps) {
  return (
    <Base
      {...p}
      kind={s.th}
      role="checkbox"
      indicator={
        <span className={s.box}>
          <svg className={s.tick} width="12" height="10" viewBox="0 0 12 10" aria-hidden>
            <path d="M1.5 5.5 L4.8 8.5 L10.5 1.5" fill="none" stroke="var(--th-toggle-indicator-icon)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      }
    />
  );
}

/** ThRadioButton */
export function RadioButton(p: BaseProps & { name?: string }) {
  return (
    <Base
      {...p}
      kind={s.th}
      role="radio"
      indicator={
        <span className={cx(s.box, s.round)}>
          <span className={s.dot} />
        </span>
      }
    />
  );
}

/** Controls.CheckBox (Basic) */
export function BasicCheckBox(p: BaseProps & { partial?: boolean }) {
  const { partial, ...rest } = p;
  return (
    <Base
      {...rest}
      kind={s.basic}
      role="checkbox"
      indicator={
        <span className={s.bbox}>
          {p.checked && !partial && (
            <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden>
              <path d="M1.5 6.2 L5.2 9.8 L12.5 1.8" fill="none" stroke="var(--th-toggle-basic-icon)" strokeWidth="2" strokeLinecap="square" />
            </svg>
          )}
          {partial && <span className={s.partial} />}
        </span>
      }
    />
  );
}

/** Controls.RadioButton (Basic) */
export function BasicRadioButton(p: BaseProps & { name?: string }) {
  return (
    <Base
      {...p}
      kind={s.basic}
      role="radio"
      indicator={
        <span className={cx(s.bbox, s.round)}>
          <span className={s.bdot} />
        </span>
      }
    />
  );
}

/** Controls.Switch (Basic) */
export function Switch(p: BaseProps) {
  return (
    <Base
      {...p}
      kind={s.basic}
      role="switch"
      indicator={
        <span className={s.sw}>
          <span className={s.track} />
          <span className={s.knob} />
        </span>
      }
    />
  );
}
