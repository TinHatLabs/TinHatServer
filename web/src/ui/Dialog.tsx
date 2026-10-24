// Dialog.tsx — modal dialogs.
//   Dialog         Controls.Dialog (Basic): palette.window box (1 px palette.dark border), bold
//                  12 px title with padding 12, content padding 12, a DialogButtonBox footer
//                  (padding 12, spacing 1, Basic buttons 40 px; one button = half width, right;
//                  several = equal widths across). Modal dim = palette.shadow at 0.5.
//   ConfirmDialog  ConfirmDialog.qml: 380 px (≤ window − 2 gridUnits), message + optional reason
//                  field, Ok/Cancel; `destructive` paints the confirm button danger-red.
// Escape and a press outside close (Qt closePolicy CloseOnEscape | CloseOnPressOutside).
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { OverlayPortal, usePopupStack } from "./overlay";
import { BACK_LEVEL_DIALOG, useBackToClose } from "./backStack";
import { useIsMobile } from "./formFactor";
import { BasicButton } from "./Button";
import { TextField } from "./TextField";
import { cx } from "./hooks";
import s from "./Dialog.module.css";

export type StandardButton = "ok" | "cancel" | "close" | "yes" | "no" | "save" | "apply" | "discard" | "help";
const LABEL: Record<StandardButton, string> = {
  ok: "OK",
  cancel: "Cancel",
  close: "Close",
  yes: "Yes",
  no: "No",
  save: "Save",
  apply: "Apply",
  discard: "Discard",
  help: "Help",
};
const ACCEPT: StandardButton[] = ["ok", "yes", "save", "apply"];
// KDE / Windows button order: accept-ish first, reject last.
const ORDER: StandardButton[] = ["help", "yes", "ok", "save", "apply", "discard", "no", "cancel", "close"];

export interface DialogButton {
  text: string;
  /** icon-pack name (Kirigami.Action icon.name) */
  icon?: string;
  role?: "accept" | "reject" | "destructive" | "action";
  onClick?: () => void;
  disabled?: boolean;
  /** render instead of the Basic button (the destructive confirm) */
  render?: (p: { onClick: () => void; disabled?: boolean; autoFocus?: boolean }) => ReactNode;
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Qt standardButtons */
  standardButtons?: StandardButton[];
  /** extra/custom footer buttons (appended, in order) */
  buttons?: DialogButton[];
  onAccepted?: () => void;
  onRejected?: () => void;
  /** relabel standard buttons */
  buttonText?: Partial<Record<StandardButton, string>>;
  width?: number | string;
  modal?: boolean;
  /** close on a press outside (default true) */
  closeOnOutside?: boolean;
  className?: string;
  bodyClassName?: string;
  style?: CSSProperties;
  children?: ReactNode;
  /** element id to focus on open (else the first focusable in the body, else the first button) */
  initialFocus?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  standardButtons = [],
  buttons = [],
  onAccepted,
  onRejected,
  buttonText,
  width,
  modal = true,
  closeOnOutside = true,
  className,
  bodyClassName,
  style,
  children,
  initialFocus,
}: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const reject = () => {
    onRejected?.();
    onClose();
  };
  usePopupStack(open, ref, { onEscape: reject, onOutside: closeOnOutside ? reject : undefined });
  // phones: the browser / Android back button cancels the dialog (shared back stack, fix/polish item 5)
  const mobile = useIsMobile();
  useBackToClose(open && mobile, reject, BACK_LEVEL_DIALOG);
  const prevFocus = useRef<Element | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    prevFocus.current = document.activeElement;
    const el = ref.current;
    if (!el) return;
    // Qt gives the dialog focus, not a button (no focus ring on open): the body's first field, else
    // the dialog itself (Enter/Esc still work; Tab walks into the buttons).
    const target =
      (initialFocus ? (document.getElementById(initialFocus) as HTMLElement | null) : null) ??
      el.querySelector<HTMLElement>("[data-body] input, [data-body] textarea, [data-body] [autofocus]") ??
      el;
    target?.focus({ preventScroll: true });
    return () => {
      (prevFocus.current as HTMLElement | null)?.focus?.({ preventScroll: true });
    };
  }, [open, initialFocus]);
  if (!open) return null;

  const std: DialogButton[] = [...standardButtons]
    .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
    .map((b) => ({
      text: buttonText?.[b] ?? LABEL[b],
      role: ACCEPT.includes(b) ? "accept" : "reject",
      onClick: ACCEPT.includes(b)
        ? () => {
            onAccepted?.();
            onClose();
          }
        : reject,
    }));
  const all = [...std, ...buttons];
  return (
    <OverlayPortal>
      {modal && <div className={s.dim} />}
      <div className={s.center}>
        <div
          ref={ref}
          role="dialog"
          aria-modal={modal}
          aria-labelledby={title ? titleId : undefined}
          className={cx(s.dialog, className)}
          style={{ width, ...style }}
          tabIndex={-1}
          onKeyDown={(e) => {
            trapTab(e, ref.current);
            // Enter on the dialog itself = the accept button (Qt Dialog default button)
            if (e.key === "Enter" && e.target === e.currentTarget) {
              const acc = all.find((b) => b.role === "accept" || b.role === "destructive");
              if (acc?.onClick) {
                e.preventDefault();
                acc.onClick();
              }
            }
          }}
        >
          {title && (
            <div id={titleId} className={s.header}>
              {title}
            </div>
          )}
          <div className={cx(s.body, bodyClassName)} data-body>
            {children}
          </div>
          {all.length > 0 && (
            <div className={cx(s.footer, all.length === 1 && s.single)} data-footer>
              {all.map((b, i) =>
                b.render ? (
                  <span key={i} className={s.fbtn}>
                    {b.render({ onClick: b.onClick ?? (() => {}), disabled: b.disabled })}
                  </span>
                ) : (
                  <BasicButton key={i} className={s.fbtn} text={b.text} icon={b.icon} onClick={b.onClick} disabled={b.disabled} />
                ),
              )}
            </div>
          )}
        </div>
      </div>
    </OverlayPortal>
  );
}

/** Keep Tab inside a modal. */
export function trapTab(e: React.KeyboardEvent, root: HTMLElement | null) {
  if (e.key !== "Tab" || !root) return;
  const f = [...root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select, [tabindex]:not([tabindex="-1"])')].filter(
    (x) => x.offsetParent !== null,
  );
  if (!f.length) return;
  const i = f.indexOf(document.activeElement as HTMLElement);
  if (e.shiftKey && (i <= 0)) {
    e.preventDefault();
    f[f.length - 1].focus();
  } else if (!e.shiftKey && i === f.length - 1) {
    e.preventDefault();
    f[0].focus();
  }
}

// ---- ConfirmDialog ---------------------------------------------------------------------------

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  /** extra class on the dialog box (e.g. a feature's phone bottom-sheet placement) */
  className?: string;
  dialogTitle?: string;
  message?: ReactNode;
  confirmText?: string;
  /** relabel Cancel ("" = style default) */
  cancelText?: string;
  destructive?: boolean;
  /** RBAC §7.2: an optional reason line sent along (kick / ban) */
  askReason?: boolean;
  reasonPlaceholder?: string;
  onConfirmed?: (reason: string) => void;
  onCancelled?: () => void;
  /** extra style on the dialog box (e.g. a transform that centres it on an in-app window) */
  style?: CSSProperties;
}

export function ConfirmDialog({
  open,
  onClose,
  dialogTitle = "Are you sure?",
  message,
  confirmText = "OK",
  cancelText = "",
  destructive,
  askReason,
  reasonPlaceholder = "Reason (optional) — they'll see it",
  onConfirmed,
  onCancelled,
  className,
  style,
}: ConfirmDialogProps) {
  const [reason, setReason] = useState("");
  const reasonId = useId();
  useEffect(() => {
    if (open) setReason("");
  }, [open]);
  const confirm = () => {
    onConfirmed?.(askReason ? reason.trim() : "");
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={dialogTitle}
      className={className}
      width="min(380px, calc(100vw - 36px))"
      style={style}
      initialFocus={askReason ? reasonId : undefined}
      onRejected={onCancelled}
      buttons={[
        destructive
          ? {
              text: confirmText,
              role: "destructive",
              onClick: confirm,
              render: ({ onClick }) => (
                <button type="button" className={s.dangerBtn} onClick={onClick}>
                  {confirmText}
                </button>
              ),
            }
          : { text: confirmText, role: "accept", onClick: confirm },
        { text: cancelText || "Cancel", role: "reject", onClick: () => (onCancelled?.(), onClose()) },
      ]}
    >
      <div className={s.confirmBody}>
        {message !== undefined && <div className={s.message}>{message}</div>}
        {askReason && (
          <TextField
            id={reasonId}
            placeholder={reasonPlaceholder}
            aria-label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onAccepted={confirm}
          />
        )}
      </div>
    </Dialog>
  );
}
