// ComboBox.tsx — ThComboBox.qml (default) and Controls.ComboBox (variant="basic").
//
// ThComboBox: a 34 px frame like ThTextField (focus OR open = the accent state),
// padding 10 / 30, an 11×7 drawn chevron 11 px from the right that turns 180° while open; the list
// opens 4 px below, ≥ 140 px wide (else the box width), padding 6, panel fill, radius 10, 1 px sep
// border, ≤ 330 px tall, fading in 90 ms / out 70 ms. Rows are 30 px, radius 6: the HOVERED /
// keyboard row is highlighted (accent at .45 — hovering moves the highlight, the hover trap) and
// the current row is DemiBold. An editable combo takes a picked row's text even when it is already
// current. Keys: ↑/↓ change the value while closed, Space/Enter/Alt+↓ open, ↑/↓/Home/End
// move the highlight, Enter picks, Esc closes.
// Basic: palette.button fill (palette.mid while pressed), no frame, a double-arrow indicator in
// palette.dark, 40 px; the list sits right under it, same width, 40 px ItemDelegate rows
// highlighted in palette.light, a 1 px palette.mid frame.
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { OverlayPortal, placePopup, rectOf, usePopupStack } from "./overlay";
import { BACK_LEVEL_POPUP, useBackToClose } from "./backStack";
import { useIsMobile } from "./formFactor";
import { Icon } from "./Icon";
import { cx, type ForceState } from "./hooks";
import s from "./ComboBox.module.css";

export interface ComboBoxProps<T> {
  model: readonly T[];
  /** the row text: a key of the item, or a function; default String(item) */
  textRole?: keyof T | ((item: T) => string);
  currentIndex: number;
  onActivated?: (index: number, item: T) => void;
  editable?: boolean;
  editText?: string;
  onEditTextChanged?: (text: string) => void;
  /** shown when currentIndex is -1 (Qt displayText) */
  displayText?: string;
  placeholder?: string;
  variant?: "th" | "basic";
  disabled?: boolean;
  force?: ForceState | "open";
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
}

export function ComboBox<T>({
  model,
  textRole,
  currentIndex,
  onActivated,
  editable,
  editText,
  onEditTextChanged,
  displayText,
  placeholder,
  variant = "th",
  disabled,
  force,
  className,
  style,
  ...aria
}: ComboBoxProps<T>) {
  const mobile = useIsMobile();
  const [open, setOpenState] = useState(force === "open");
  // a touch tap opens on its click, not on pointerdown (see onPointerDown)
  const tapOpen = useRef(false);
  const [hl, setHl] = useState(currentIndex);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const textOf = (it: T | undefined): string => {
    if (it === undefined || it === null) return "";
    if (typeof textRole === "function") return textRole(it);
    if (textRole !== undefined) return String((it as Record<string, unknown>)[textRole as string] ?? "");
    return String(it);
  };
  const shown = displayText ?? (currentIndex >= 0 ? textOf(model[currentIndex]) : "");
  const setOpen = (o: boolean) => {
    if (o) setHl(currentIndex);
    setOpenState(o);
  };
  const pick = (i: number) => {
    setOpenState(false);
    if (i < 0 || i >= model.length) return;
    if (editable) {
      const t = textOf(model[i]);
      if (t !== editText) onEditTextChanged?.(t);
    }
    onActivated?.(i, model[i]);
  };
  const onKey = (e: KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === "ArrowDown" && e.altKey) setOpen(true);
      else if (e.key === "ArrowDown" && !editable) currentIndex < model.length - 1 && onActivated?.(currentIndex + 1, model[currentIndex + 1]);
      else if (e.key === "ArrowUp" && !editable) currentIndex > 0 && onActivated?.(currentIndex - 1, model[currentIndex - 1]);
      else if ((e.key === " " && !editable) || (e.key === "Enter" && !editable)) setOpen(true);
      else return;
    } else {
      if (e.key === "ArrowDown") setHl((h) => Math.min(model.length - 1, h + 1));
      else if (e.key === "ArrowUp") setHl((h) => Math.max(0, h - 1));
      else if (e.key === "Home") setHl(0);
      else if (e.key === "End") setHl(model.length - 1);
      else if (e.key === "Enter" || (e.key === " " && !editable)) pick(hl);
      else if (e.key === "Escape") setOpenState(false);
      else return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  const isOpen = open || force === "open";
  return (
    <div
      ref={boxRef}
      className={cx(variant === "basic" ? s.basic : s.th, isOpen && s.open, disabled && s.disabled, className)}
      style={style}
      data-force={force === "open" ? undefined : force}
      role="combobox"
      aria-expanded={isOpen}
      aria-controls={listId}
      aria-haspopup="listbox"
      aria-disabled={disabled || undefined}
      aria-label={aria["aria-label"]}
      tabIndex={editable || disabled ? -1 : 0}
      onKeyDown={onKey}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        if (editable && (e.target as HTMLElement).tagName === "INPUT") return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).focus();
        // touch / pen: open on the tap's click instead — opened on pointerdown, the phone bottom sheet
        // slid under the finger and the same tap's click picked whatever option landed there (ghost
        // click: tapping 7:00 PM in the calendar editor set 5:45 PM). A scroll that starts on the box
        // no longer opens it either (no click follows a pan).
        tapOpen.current = false; // a new gesture: forget an earlier tap that never clicked (a pan)
        if (e.pointerType === "touch" || e.pointerType === "pen") {
          tapOpen.current = true;
          return;
        }
        setOpen(!isOpen);
      }}
      onPointerCancel={() => (tapOpen.current = false)}
      onClick={(e) => {
        if (!tapOpen.current) return;
        tapOpen.current = false;
        if (disabled || (editable && (e.target as HTMLElement).tagName === "INPUT")) return;
        setOpen(!isOpen);
      }}
    >
      {editable ? (
        <input
          className={s.input}
          value={editText ?? ""}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onEditTextChanged?.(e.target.value)}
          onKeyDown={onKey}
          spellCheck={false}
        />
      ) : (
        <span className={cx(s.display, !shown && s.placeholder)}>{shown || placeholder || ""}</span>
      )}
      {variant === "basic" ? (
        <svg className={s.double} width="14" height="20" viewBox="0 0 14 20" aria-hidden>
          <path d="M3 8 L7 4 L11 8 M3 12 L7 16 L11 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg className={s.chev} width="11" height="7" viewBox="0 0 11 7" aria-hidden>
          <path d="M1.2 1.5 L5.5 5.5 L9.8 1.5" fill="none" stroke="var(--th-combo-icon)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {isOpen && !disabled && (
        <ComboList
          id={listId}
          variant={variant}
          mobile={mobile}
          anchor={boxRef.current}
          items={model.map(textOf)}
          current={currentIndex}
          highlight={hl}
          setHighlight={setHl}
          onPick={pick}
          onClose={() => setOpenState(false)}
          title={aria["aria-label"]}
        />
      )}
    </div>
  );
}

function ComboList({
  id,
  variant,
  mobile,
  anchor,
  items,
  current,
  highlight,
  setHighlight,
  onPick,
  onClose,
  title,
}: {
  id: string;
  variant: "th" | "basic";
  mobile: boolean;
  anchor: HTMLElement | null;
  items: string[];
  current: number;
  highlight: number;
  setHighlight: (i: number) => void;
  onPick: (i: number) => void;
  onClose: () => void;
  title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; w: number } | null>(null);
  usePopupStack(true, ref, { onEscape: onClose, onOutside: onClose, inside: () => [anchor] });
  useBackToClose(mobile, onClose, BACK_LEVEL_POPUP); // phones: back closes the option sheet (shared back stack)
  useLayoutEffect(() => {
    if (mobile) return;
    const el = ref.current;
    const a = rectOf(anchor);
    if (!el || !a) return;
    const w = variant === "basic" ? a.width : Math.max(a.width, 140);
    el.style.width = `${w}px`;
    const p = placePopup({ anchor: a, size: { width: w, height: el.offsetHeight }, placement: "below", gap: variant === "basic" ? 0 : 4, margins: 6, flip: true });
    setPos({ x: p.x, y: p.y, w });
  }, [anchor, variant, mobile, items.length]);
  // keep the highlighted row in view
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(`[data-i="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlight]);
  if (mobile) {
    return (
      <OverlayPortal>
        <div className={s.sheetDim} />
        <div ref={ref} id={id} role="listbox" className={s.sheet} onPointerDown={(e) => e.stopPropagation()}>
          <div className={s.grab} />
          {title && <div className={s.sheetTitle}>{title}</div>}
          <div className={s.sheetBody}>
            {items.map((t, i) => (
              <div key={i} role="option" aria-selected={i === current} data-i={i} className={cx(s.mRow, i === current && s.current)} onClick={() => onPick(i)}>
                <span className={s.rowText}>{t}</span>
                {i === current && <Icon name="checkmark-symbolic" size={22} color="var(--th-sheet-bottom-item-icon-checked)" />}
              </div>
            ))}
          </div>
        </div>
      </OverlayPortal>
    );
  }
  return (
    <OverlayPortal>
      <div
        ref={ref}
        id={id}
        role="listbox"
        className={variant === "basic" ? s.bList : s.list}
        style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? "visible" : "hidden" }}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {items.map((t, i) => (
          <div
            key={i}
            role="option"
            aria-selected={i === current}
            data-i={i}
            className={cx(variant === "basic" ? s.bRow : s.row, i === highlight && s.hl, i === current && s.current)}
            onPointerEnter={(e) => e.pointerType !== "touch" && setHighlight(i)}
            onClick={() => onPick(i)}
          >
            <span className={s.rowText}>{t}</span>
          </div>
        ))}
      </div>
    </OverlayPortal>
  );
}
