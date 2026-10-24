// rows.tsx — the Settings window's content shapes (SETTINGS-WINDOW.md §3): a Section (heading 14/600, optional hint,
// then its Card), a Card (radius 10, 1 px frame, 1 px dividers between rows) and the Row (label 14/500 + description
// 12, the control on the right, vertically centred, 16 gap; or stacked: the control full width 10 below). Narrow
// content (< 560 px — every phone) stacks every row but switch rows (the switch stays on the right, like every phone
// settings list — STATUS.md D-SW3). Every row carries its settings-index anchor as `data-setting` so search can
// scroll to it and flash it.
//
// A leaf module (only @/ui): other features' settings sections (actions' Buttons / Shortcuts, editmode's Layout) use
// these shapes too without importing the rest of the settings feature.
import { useId, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { ComboBox, Icon, Switch, cx, type ComboBoxProps } from "@/ui";
import s from "./rows.module.css";
import "./settingsFlash.css";

export function Section({
  title,
  hint,
  bare,
  id,
  className,
  children,
  actions,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  /** no card: the children sit straight in the section (Appearance's theme gallery) */
  bare?: boolean;
  /** data-section (tests) */
  id?: string;
  className?: string;
  /** a small tool on the heading's right (Invites' Refresh) */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={cx(s.section, className)} data-section={id}>
      {(title || actions) && (
        <div className={s.sectionHead}>
          {title && <h3 className={s.sectionTitle}>{title}</h3>}
          {actions && <span className={s.sectionActions}>{actions}</span>}
        </div>
      )}
      {hint && <p className={s.sectionHint}>{hint}</p>}
      {bare ? <div className={s.bare}>{children}</div> : <Card>{children}</Card>}
    </section>
  );
}

export function Card({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={cx(s.card, className)} style={style}>
      {children}
    </div>
  );
}

export interface RowProps {
  /** settings-index.json anchor (data-setting) */
  id?: string;
  label: ReactNode;
  description?: ReactNode;
  /** the control on the right (inline); stacks under the text when the content is narrow */
  control?: ReactNode;
  /** wide content under the text, full width (text fields, meters, lists, the join-sound picker …) */
  children?: ReactNode;
  /** keep the control on the right even when narrow (switches) */
  inline?: boolean;
  /** leading icon (status rows: verification, key backup, a device) */
  icon?: ReactNode;
  /** the label is a <label> for this control id (a click on the text toggles a switch) */
  labelFor?: string;
  disabled?: boolean;
  /** the label in the danger colour (Echo cancellation NOT ACTIVE) */
  labelTone?: "danger";
  className?: string;
  /** extra attributes for tests (data-device-id …) */
  attrs?: Record<string, string | undefined>;
  /** handlers on the row element (a right-click menu) */
  rowProps?: HTMLAttributes<HTMLDivElement>;
}

export function Row({ id, label, description, control, children, inline, icon, labelFor, disabled, labelTone, className, attrs, rowProps }: RowProps) {
  const L = labelFor ? "label" : "span";
  return (
    <div {...rowProps} className={cx(s.row, inline && s.inline, disabled && s.disabled, className)} data-setting={id} {...attrs}>
      <div className={s.main}>
        {icon && <span className={s.icon}>{icon}</span>}
        <div className={s.text}>
          <L className={cx(s.label, labelTone === "danger" && s.labelDanger)} htmlFor={labelFor}>
            {label}
          </L>
          {description && <span className={s.desc}>{description}</span>}
        </div>
        {control && <div className={s.control}>{control}</div>}
      </div>
      {children !== undefined && children !== null && children !== false && <div className={s.stackBody}>{children}</div>}
    </div>
  );
}

/** A row whose control is a switch (every on/off, §3). The whole label toggles it. */
export function SwitchRow({
  id,
  label,
  description,
  checked,
  onToggled,
  disabled,
  children,
  labelTone,
  switchAttrs,
}: {
  id?: string;
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onToggled: (on: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
  labelTone?: "danger";
  switchAttrs?: Record<string, string | undefined>;
}) {
  const cid = useId();
  const aria = typeof label === "string" ? label : undefined;
  return (
    <Row
      id={id}
      label={label}
      description={description}
      inline
      labelFor={cid}
      disabled={disabled}
      labelTone={labelTone}
      control={<Switch id={cid} className={s.switch} checked={checked} disabled={disabled} aria-label={aria} onToggled={onToggled} {...switchAttrs} />}
    >
      {children}
    </Row>
  );
}

/** A row with a 240 px combo (full width when narrow); `after` = a small button beside it (Preview). */
export function ComboRow<T>({
  id,
  label,
  description,
  disabled,
  children,
  after,
  ...combo
}: { id?: string; label: ReactNode; description?: ReactNode; disabled?: boolean; children?: ReactNode; after?: ReactNode } & ComboBoxProps<T>) {
  const box = <ComboBox {...combo} disabled={disabled} className={cx(s.combo, combo.className)} aria-label={combo["aria-label"] ?? (typeof label === "string" ? label : undefined)} />;
  return (
    <Row
      id={id}
      label={label}
      description={description}
      disabled={disabled}
      control={
        after ? (
          <span className={s.comboAfter}>
            {box}
            {after}
          </span>
        ) : (
          box
        )
      }
    >
      {children}
    </Row>
  );
}

/** A one-line note inside a card (the overlay's "unavailable" line, the browser's notification permission …). */
export function NoteRow({ children, tone, icon }: { children: ReactNode; tone?: "warning" | "danger" | "ok"; icon?: string }) {
  return (
    <div className={cx(s.note, tone === "danger" && s.noteDanger, tone === "warning" && s.noteWarning, tone === "ok" && s.noteOk)}>
      {icon && <Icon name={icon} size={16} color="currentColor" staticOnly />}
      <span>{children}</span>
    </div>
  );
}

/** A small pill after a label ("This device", "changed"). */
export function Chip({ children }: { children: ReactNode }) {
  return <span className={s.chip}>{children}</span>;
}

/** Inline hint text for a stacked body (12 px, the description colour). */
export function Hint({ children, className, tone }: { children: ReactNode; className?: string; tone?: "danger" | "ok" }) {
  return <div className={cx(s.hint, tone === "danger" && s.hintDanger, tone === "ok" && s.hintOk, className)}>{children}</div>;
}

/** Buttons side by side in a stacked body (wraps). */
export function Buttons({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(s.buttons, className)}>{children}</div>;
}

export { s as rowStyles };
