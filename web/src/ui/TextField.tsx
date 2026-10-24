// TextField.tsx — the text inputs.
//   TextField      ThTextField.qml  — house field: 34 px, radius 8, bg → panelHi on hover →
//                                        lighter(panelHi, 1.08) + 2 px accentBright on focus
//   TextArea       ThTextArea.qml   — same visuals, padding 10, wraps, grows with content
//   BasicTextField Controls.TextField — Basic: 40 px, palette.base fill, 1 px palette.mid border,
//                                        2 px palette.highlight on focus, padding 6 / left 10
//   SearchField    Kirigami.SearchField — BasicTextField + "search" glyph (16, placeholder colour)
//                                        8 px in, text at 28, a clear button when it has text
// All forward the native input props (value/onChange/placeholder/…); `onAccepted` = Enter.
import {
  forwardRef,
  useLayoutEffect,
  useRef,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type TextareaHTMLAttributes,
} from "react";
import { Icon } from "./Icon";
import { cx, mergeRefs, type ForceState } from "./hooks";
import s from "./TextField.module.css";

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  onAccepted?: (value: string) => void;
  force?: ForceState;
  radius?: number;
};

function acceptOnEnter(onAccepted: InputProps["onAccepted"], onKeyDown: InputProps["onKeyDown"]) {
  return (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (!e.defaultPrevented && e.key === "Enter" && !e.nativeEvent.isComposing && onAccepted) {
      e.preventDefault();
      onAccepted(e.currentTarget.value);
    }
  };
}

/** ThTextField */
export const TextField = forwardRef<HTMLInputElement, InputProps>(function TextField(
  { className, onAccepted, onKeyDown, force, radius, style, type = "text", ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      className={cx(s.th, className)}
      data-force={force}
      style={radius !== undefined ? { ...style, borderRadius: radius } : style}
      spellCheck={false}
      onKeyDown={acceptOnEnter(onAccepted, onKeyDown)}
      {...rest}
    />
  );
});

type AreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  force?: ForceState;
  radius?: number;
  /** grow with the content (the QML implicitHeight rule); default true */
  autoGrow?: boolean;
};

/** ThTextArea */
export const TextArea = forwardRef<HTMLTextAreaElement, AreaProps>(function TextArea(
  { className, force, radius, style, autoGrow = true, value, onInput, ...rest },
  ref,
) {
  const own = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = own.current;
    if (!el || !autoGrow) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value, autoGrow]);
  return (
    <textarea
      ref={mergeRefs(ref, own)}
      className={cx(s.th, s.area, className)}
      data-force={force}
      style={radius !== undefined ? { ...style, borderRadius: radius } : style}
      value={value}
      onInput={(e) => {
        if (autoGrow) {
          const el = e.currentTarget;
          el.style.height = "auto";
          el.style.height = `${el.scrollHeight}px`;
        }
        onInput?.(e);
      }}
      {...rest}
    />
  );
});

/** Controls.TextField (Basic) */
export const BasicTextField = forwardRef<HTMLInputElement, InputProps>(function BasicTextField(
  { className, onAccepted, onKeyDown, force, type = "text", ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      className={cx(s.basic, className)}
      data-force={force}
      spellCheck={false}
      onKeyDown={acceptOnEnter(onAccepted, onKeyDown)}
      {...rest}
    />
  );
});

export interface SearchFieldProps extends InputProps {
  /** controlled value — needed for the clear button */
  value: string;
  onValueChange: (v: string) => void;
}

/** Kirigami.SearchField (placeholder "Search…" by default; Escape/clear button empties it). */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { className, value, onValueChange, onAccepted, onKeyDown, placeholder = "Search…", force, style, ...rest },
  ref,
) {
  const own = useRef<HTMLInputElement>(null);
  return (
    <span className={cx(s.searchWrap, className)} style={style}>
      <input
        ref={mergeRefs(ref, own)}
        type="search"
        className={cx(s.basic, s.search, value && s.hasClear)}
        data-force={force}
        placeholder={placeholder}
        value={value}
        spellCheck={false}
        enterKeyHint="search"
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={acceptOnEnter(onAccepted, onKeyDown)}
        aria-label={rest["aria-label"] ?? "Search"}
        {...rest}
      />
      <span className={s.searchIcon}>
        <Icon name="search" size={16} color="var(--th-input-search-icon)" />
      </span>
      {value && (
        <button
          type="button"
          className={s.clear}
          aria-label="Clear search"
          title="Clear search"
          tabIndex={-1}
          onClick={() => {
            onValueChange("");
            onAccepted?.("");
            own.current?.focus();
          }}
        >
          <Icon name="edit-clear-locationbar-rtl" size={16} color="var(--th-input-search-clear-icon)" />
        </button>
      )}
    </span>
  );
});
