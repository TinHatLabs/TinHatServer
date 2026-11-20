// HeaderIconButton.tsx — HeaderIconButton.qml: the round, flat room-header button.
// size gridUnit×2 (36); hover: a soft accentBright wash (0.18, 0.30 pressed) inset 2 px, a 2 px
// accentBright glow ring 1 px outside at 0.35, the 22 px glyph scales 1.16 and tilts −3° with an
// OutBack ease; `accent` tints the glyph accentBright and holds its story (active call, open panel).
// Inside a <HeaderButtonLabel> (the phone room header's ⋯ More sheet) the same button is a full-width list row: the
// glyph, then its label as real text (the label given, else the button's tip), and that text is its accessible name.
import { createContext, forwardRef, useContext, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
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
  const row = useContext(LabelCtx);
  // a labelled row shows its words, so it needs no tooltip; its visible text is its name (WCAG 2.5.3)
  const text = row ? (row.label ?? tip ?? rest["aria-label"] ?? "") : null;
  useTip(own, row ? undefined : tip);
  const hp = useHoverPress(disabled);
  const hovered = hp.hovered || force === "hover" || force === "pressed";
  return (
    <button
      ref={mergeRefs(ref, own)}
      type="button"
      className={cx(s.btn, row && s.labelled, hovered && s.hovered, (hp.pressed || force === "pressed") && s.pressed, className)}
      style={row ? style : { width: size, height: size, ...style }}
      disabled={disabled}
      data-force={force}
      aria-label={tip}
      {...hp.handlers}
      {...rest}
      {...(row ? { "aria-label": text ?? undefined, "aria-labelledby": undefined } : {})}
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
      {row && <span className={s.label}>{text}</span>}
    </button>
  );
});

const LabelCtx = createContext<{ label?: string } | null>(null);

/** True inside a <HeaderButtonLabel>: a row renderer (ActionButton) draws its item as the labelled HeaderIconButton
 *  there whatever the row's look, so every row of the sheet reads the same. */
export function useInHeaderButtonLabel(): boolean {
  return useContext(LabelCtx) !== null;
}

/** Draws the HeaderIconButtons inside it as labelled list rows (the phone room header's ⋯ More sheet). `label` = the
 *  words to show (the actions contract's, for a row item); without one each button shows its own tip. */
export function HeaderButtonLabel({ label, children }: { label?: string; children: ReactNode }) {
  return <LabelCtx.Provider value={{ label }}>{children}</LabelCtx.Provider>;
}
