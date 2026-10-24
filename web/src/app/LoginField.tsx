// LoginField.tsx — LoginField.qml: a dim bold small-font label (4 px in) over a rounded (12) field
// frame 2.2 gridUnits tall — bg → lighter(panelHi, 1.08) + a 2 px accentBright border on focus,
// with a 3 px accentBright halo at 0.22 just outside it — holding a 16 px icon (accentBright
// while focused), an optional bold monospace prefix ("TH-"), the chromeless input, and for
// passwords an eye toggle with a round accentBright hover wash and a tooltip.
import { forwardRef, useId, useRef, useState } from "react";
import { Icon, mergeRefs, useTip } from "@/ui";
import s from "./LoginField.module.css";

export interface LoginFieldProps {
  label: string;
  icon?: string;
  placeholder?: string;
  password?: boolean;
  prefix?: string;
  value: string;
  onChange: (v: string) => void;
  onAccepted?: () => void;
  disabled?: boolean;
  autoComplete?: string;
  inputMode?: "text" | "email";
  name?: string;
}

export const LoginField = forwardRef<HTMLInputElement, LoginFieldProps>(function LoginField(
  { label, icon, placeholder, password, prefix, value, onChange, onAccepted, disabled, autoComplete, inputMode, name },
  ref,
) {
  const id = useId();
  const [show, setShow] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const eye = useRef<HTMLButtonElement>(null);
  useTip(eye, show ? "Hide password" : "Show password");
  return (
    <div className={`${s.field} ${disabled ? s.disabled : ""}`}>
      <label className={s.label} htmlFor={id}>
        {label}
      </label>
      <div className={s.frame} onPointerDown={(e) => e.target === e.currentTarget && (e.preventDefault(), input.current?.focus())}>
        <span className={s.halo} />
        {icon && (
          <span className={s.icon}>
            <Icon name={icon} size={16} color="var(--icon-color)" />
          </span>
        )}
        {prefix && <span className={s.prefix}>{prefix}</span>}
        <input
          ref={mergeRefs(ref, input)}
          id={id}
          name={name}
          className={s.input}
          type={password && !show ? "password" : "text"}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete={autoComplete}
          inputMode={inputMode}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onAccepted?.();
            }
          }}
        />
        {password && (
          <button
            ref={eye}
            type="button"
            className={s.eye}
            tabIndex={-1}
            aria-label={show ? "Hide password" : "Show password"}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => setShow((v) => !v)}
          >
            <span className={s.wash} />
            <Icon name={show ? "view-hidden-symbolic" : "view-visible-symbolic"} size={16} color="var(--eye-color)" />
          </button>
        )}
      </div>
    </div>
  );
});
