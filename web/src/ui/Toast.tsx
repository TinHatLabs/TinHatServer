// Toast.tsx — Kirigami's passive notifications (ApplicationWindow.showPassiveNotification), the
// app-wide transient notice. Bottom-centre stack (newest at the bottom, 4 max, 4 px apart, 8 px
// off the window edge), each ≤ min(25 gridUnits, window / 1.5) wide: padding 8, a 12 px wrapped
// label + an optional Basic button, on the Complementary background (= the theme bg here) at 0.9
// with radius 5 and a 9 px black .4 shadow 2 px down. Timeouts: 7 s default, "short" 4 s, "long"
// 12 s, or ms; hover pauses; a tap dismisses. Enters sliding down 3 gridUnits + fading in (200 ms).
//
// Show one: `toast("Copied")` from @/core/bus (the ToastHost listens), or `showToast()` here.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useBus, type BusEvents } from "@/core/bus";
import { OverlayPortal } from "./overlay";
import { BasicButton } from "./Button";
import s from "./Toast.module.css";

export interface ToastItem {
  id: number;
  message: string;
  timeoutMs: number;
  actionText?: string;
  onAction?: () => void;
  leaving?: boolean;
}

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}

export function showToast(message: string, timeout?: number | "short" | "long", action?: { label: string; run: () => void }): void {
  if (!message) return;
  const ms = timeout === "short" ? 4000 : timeout === "long" ? 12000 : typeof timeout === "number" && timeout > 0 ? timeout : 7000;
  items = [...items, { id: ++seq, message, timeoutMs: ms, actionText: action?.label, onAction: action?.run }];
  const live = items.filter((t) => !t.leaving);
  if (live.length > 4) hideToast(live[0].id);
  emit();
}

export function hideToast(id: number): void {
  if (!items.some((t) => t.id === id && !t.leaving)) return;
  items = items.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  emit();
  window.setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, 200);
}

function useToasts(): ToastItem[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => items,
    () => items,
  );
}

/** Mounted once by the App: renders the stack and listens for bus `toast`. */
export function ToastHost() {
  const list = useToasts();
  useBus("toast", (t: BusEvents["toast"]) => showToast(t.message, t.timeoutMs, t.action ? { label: t.action.label, run: t.action.run } : undefined));
  if (!list.length) return null;
  return (
    <OverlayPortal>
      <div className={s.host} aria-live="polite" data-toast-host>
        {list.map((t) => (
          <ToastView key={t.id} t={t} />
        ))}
      </div>
    </OverlayPortal>
  );
}

function ToastView({ t }: { t: ToastItem }) {
  const [hover, setHover] = useState(false);
  const left = useRef(t.timeoutMs);
  useEffect(() => {
    if (hover || t.leaving) return;
    const start = Date.now();
    const timer = window.setTimeout(() => hideToast(t.id), left.current);
    return () => {
      window.clearTimeout(timer);
      left.current -= Date.now() - start;
    };
  }, [hover, t.id, t.leaving]);
  return (
    <div
      className={`${s.toast} ${t.leaving ? s.leaving : ""}`}
      role="status"
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onClick={() => hideToast(t.id)}
    >
      <span className={s.bg} />
      <span className={s.text}>{t.message}</span>
      {t.actionText && (
        <BasicButton
          text={t.actionText}
          onClick={(e) => {
            e.stopPropagation();
            hideToast(t.id);
            t.onAction?.();
          }}
        />
      )}
    </div>
  );
}
