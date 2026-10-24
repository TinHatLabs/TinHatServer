// Slider.tsx — Controls.Slider (Basic style with the app palette): padding 6, a 6 px groove
// (radius 3) in palette.midlight with the progress in palette.dark, a 28 px round handle in
// palette.window (palette.light while pressed) with a 1 px palette.mid border (2 px
// palette.highlight on focus). Pointer drag, wheel, and the Qt keys (arrows, PgUp/PgDn,
// Home/End). `onMoved` fires on user changes (Qt `moved`), `onRelease` when a drag ends.
import { useCallback, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { cx, type ForceState } from "./hooks";
import s from "./Slider.module.css";

export interface SliderProps {
  value: number;
  from?: number;
  to?: number;
  stepSize?: number;
  orientation?: "horizontal" | "vertical";
  onMoved?: (v: number) => void;
  onRelease?: (v: number) => void;
  disabled?: boolean;
  force?: ForceState;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
  /** wheel steps the value (Qt: wheelEnabled = true) */
  wheel?: boolean;
}

export function Slider({
  value,
  from = 0,
  to = 1,
  stepSize = 0,
  orientation = "horizontal",
  onMoved,
  onRelease,
  disabled,
  force,
  className,
  style,
  wheel = true,
  ...aria
}: SliderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pressed, setPressed] = useState(false);
  const horiz = orientation === "horizontal";
  const range = to - from || 1;
  const pos = Math.max(0, Math.min(1, (value - from) / range));
  const snap = useCallback(
    (v: number) => {
      let x = Math.max(Math.min(from, to), Math.min(Math.max(from, to), v));
      if (stepSize > 0) x = from + Math.round((x - from) / stepSize) * stepSize;
      return Number(x.toFixed(6));
    },
    [from, to, stepSize],
  );
  const fromPointer = (e: PointerEvent) => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    const avail = (horiz ? r.width : r.height) - 12 - 28;
    const p = horiz ? (e.clientX - r.left - 6 - 14) / avail : 1 - (e.clientY - r.top - 6 - 14) / avail;
    return snap(from + Math.max(0, Math.min(1, p)) * range);
  };
  const step = stepSize > 0 ? stepSize : range / 100;
  const onKey = (e: KeyboardEvent) => {
    let v: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") v = value + step;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") v = value - step;
    else if (e.key === "PageUp") v = value + step * 10;
    else if (e.key === "PageDown") v = value - step * 10;
    else if (e.key === "Home") v = from;
    else if (e.key === "End") v = to;
    if (v === null) return;
    e.preventDefault();
    const n = snap(v);
    if (n !== value) onMoved?.(n);
    onRelease?.(n);
  };
  // visualPosition: vertical sliders run bottom (from) → top (to)
  const handleStyle: CSSProperties = horiz
    ? { left: `calc(6px + ${pos} * (100% - 12px - 28px))` }
    : { top: `calc(6px + ${1 - pos} * (100% - 12px - 28px))` };
  const fillStyle: CSSProperties = horiz ? { width: `${pos * 100}%` } : { height: `${pos * 100}%` };
  return (
    <div
      ref={ref}
      className={cx(s.slider, horiz ? s.h : s.v, (pressed || force === "pressed") && s.pressed, disabled && s.disabled, className)}
      style={style}
      data-force={force}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-valuemin={from}
      aria-valuemax={to}
      aria-valuenow={value}
      aria-orientation={orientation}
      aria-disabled={disabled || undefined}
      aria-label={aria["aria-label"]}
      onKeyDown={disabled ? undefined : onKey}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setPressed(true);
        const n = fromPointer(e);
        if (n !== value) onMoved?.(n);
      }}
      onPointerMove={(e) => {
        if (!pressed) return;
        const n = fromPointer(e);
        if (n !== value) onMoved?.(n);
      }}
      onPointerUp={(e) => {
        if (!pressed) return;
        setPressed(false);
        onRelease?.(fromPointer(e));
      }}
      onPointerCancel={() => setPressed(false)}
      onWheel={
        wheel && !disabled
          ? (e) => {
              const d = e.deltaY < 0 || e.deltaX > 0 ? step : -step;
              const n = snap(value + d);
              if (n !== value) {
                onMoved?.(n);
                onRelease?.(n);
              }
            }
          : undefined
      }
    >
      <span className={s.groove}>
        <span className={s.fill} style={fillStyle} />
      </span>
      <span className={s.handle} style={handleStyle} />
    </div>
  );
}
