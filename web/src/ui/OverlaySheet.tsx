// OverlaySheet.tsx — the two Kirigami popups the app uses.
//
//   OverlaySheet  Kirigami.OverlaySheet (Settings, About, Tour, …): modal, black 0.5 dim, centred
//                 horizontally, as wide as its content's preferred width (≤ the window), top at
//                 max(centred, 3 gridUnits); header = a level-2 Heading with 8 px padding and a
//                 40 px Basic close ToolButton 8 px from the top-right corner (window-close on
//                 hover); a separator under the header while the content scrolls; content inset
//                 largeSpacing (8); the Kirigami card background (View bg, radius 5, 1 px frame).
//                 Esc closes (closePolicy CloseOnEscape); so does a click on the dim.
//   PromptDialog  Kirigami.PromptDialog: no header, the title as a level-1 Heading + optional
//                 subtitle inside 8 px padding, your content below (spacing 4), a footer of
//                 buttons (padding 8); rounded 5 px card with a 1 px separator-coloured frame and a
//                 soft shadow, black 0.3 dim; fades in while rising 36 px (longDuration 200 ms).
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { OverlayPortal, usePopupStack } from "./overlay";
import { BasicButton } from "./Button";
import { Icon } from "./Icon";
import { useIsMobile } from "./formFactor";
import { BACK_LEVEL_DIALOG, useBackToClose } from "./backStack";
import { trapTab, type DialogButton, type StandardButton } from "./Dialog";
import { cx, useHoverPress } from "./hooks";
import s from "./OverlaySheet.module.css";

export interface OverlaySheetProps {
  open: boolean;
  onClose: () => void;
  /** header text (Kirigami title → a level-2 Heading) */
  title?: string;
  /** custom header item (replaces the title heading) */
  header?: ReactNode;
  footer?: ReactNode;
  showCloseButton?: boolean;
  /** the content's preferred width (Layout.preferredWidth) = the sheet's width (its 1 px frame is
   *  drawn just outside; the content sits 8 px inside); default = full window width */
  preferredWidth?: number;
  /** fixed height (e.g. Settings uses most of the window); default = content height */
  height?: number | string;
  className?: string;
  bodyClassName?: string;
  style?: CSSProperties;
  children?: ReactNode;
  /** content scrolls inside the sheet (default true) */
  scroll?: boolean;
  /** phones: the browser / Android back button (shared back stack). Default = onClose; return false to
   *  stay open (e.g. step back from a sub-page first). */
  onBack?: () => boolean | void;
}

export function OverlaySheet({
  open,
  onClose,
  title,
  header,
  footer,
  showCloseButton = true,
  preferredWidth,
  height,
  className,
  bodyClassName,
  style,
  children,
  scroll = true,
  onBack,
}: OverlaySheetProps) {
  const mobile = useIsMobile();
  useBackToClose(open && mobile, () => (onBack ? onBack() : onClose()));
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [top, setTop] = useState<number | null>(null);
  usePopupStack(open, ref, { onEscape: onClose });
  useLayoutEffect(() => {
    if (!open || !body.current || !ref.current) return;
    const el = body.current, sheet = ref.current;
    const check = () => {
      setOverflow(el.scrollHeight > el.clientHeight + 1);
      // y = max(centred, 3 gridUnits)
      setTop(Math.round(Math.max(54, (window.innerHeight - sheet.offsetHeight) / 2)));
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    ro.observe(sheet);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    window.addEventListener("resize", check);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", check);
    };
  }, [open]);
  const close = useHoverPress();
  if (!open) return null;
  return (
    <OverlayPortal>
      <div className={s.dim} onClick={onClose} />
      <div
        className={s.sheetWrap}
        style={mobile ? undefined : { ["--sheet-w" as string]: preferredWidth ? `${preferredWidth}px` : "100%", top: top ?? 54, visibility: top === null ? "hidden" : undefined }}
      >
        <div
          ref={ref}
          role="dialog"
          aria-modal
          aria-label={title}
          className={cx(s.sheet, mobile && s.mobile, className)}
          style={{ height, ...style }}
          onKeyDown={(e) => trapTab(e, ref.current)}
        >
          {(header || title || showCloseButton) && (
            <div className={s.header}>
              <div className={s.headerContent}>{header ?? <div className={s.title}>{title}</div>}</div>
              {showCloseButton && (
                <button
                  type="button"
                  className={s.close}
                  aria-label="Close"
                  title="Close"
                  onClick={onClose}
                  {...close.handlers}
                >
                  <Icon name={close.hovered ? "window-close" : "window-close-symbolic"} size={24} isMask={!close.hovered} />
                </button>
              )}
              {overflow && <div className={s.headerSep} />}
            </div>
          )}
          <div ref={body} className={cx(s.body, !scroll && s.noScroll, bodyClassName)}>
            {children}
          </div>
          {footer && (
            <>
              <div className={s.sep} />
              <div className={s.footer}>{footer}</div>
            </>
          )}
        </div>
      </div>
    </OverlayPortal>
  );
}

// ---- Kirigami.PromptDialog -------------------------------------------------------------------

export interface PromptDialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: ReactNode;
  standardButtons?: StandardButton[];
  /** customFooterActions (Controls.Button each), after the standard buttons */
  actions?: DialogButton[];
  onAccepted?: () => void;
  onRejected?: () => void;
  /** preferredWidth (px) */
  preferredWidth?: number;
  dialogType?: "success" | "warning" | "error" | "information";
  className?: string;
  children?: ReactNode;
}

const PD_LABEL: Record<StandardButton, string> = {
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

export function PromptDialog({
  open,
  onClose,
  title,
  subtitle,
  standardButtons = [],
  actions = [],
  onAccepted,
  onRejected,
  preferredWidth,
  dialogType,
  className,
  children,
}: PromptDialogProps) {
  const mobilePD = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  const reject = () => {
    onRejected?.();
    onClose();
  };
  usePopupStack(open, ref, { onEscape: reject, onOutside: reject });
  useBackToClose(open && mobilePD, reject, BACK_LEVEL_DIALOG); // phones: back = Cancel
  useLayoutEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, textarea, [autofocus]")?.focus({ preventScroll: true });
    return () => prev?.focus?.({ preventScroll: true });
  }, [open]);
  if (!open) return null;
  const accept = ["ok", "yes", "save", "apply"];
  const std: DialogButton[] = standardButtons.map((b) => ({
    text: PD_LABEL[b],
    onClick: accept.includes(b)
      ? () => {
          onAccepted?.();
          onClose();
        }
      : reject,
  }));
  const buttons = [...std, ...actions];
  const icon = dialogType ? `data-${dialogType}` : "";
  return (
    <OverlayPortal>
      <div className={s.pdDim} />
      <div className={s.center}>
        <div
          ref={ref}
          role="dialog"
          aria-modal
          aria-label={title}
          className={cx(s.prompt, className)}
          style={{ width: preferredWidth ? `min(${preferredWidth + 2}px, calc(100vw - 16px))` : undefined }}
          onKeyDown={(e) => trapTab(e, ref.current)}
        >
          <div className={cx(s.pdContent, buttons.length > 0 && s.pdHasFooter)}>
            {icon && <Icon name={icon} size={64} isMask={false} className={s.pdIcon} />}
            <div className={s.pdMain}>
              <div>
                {title && <div className={s.pdTitle}>{title}</div>}
                {subtitle && <div className={s.pdSubtitle}>{subtitle}</div>}
              </div>
              {children}
            </div>
          </div>
          {buttons.length > 0 && (
            <div className={s.pdFooter}>
              {buttons.map((b, i) =>
                b.render ? (
                  <span key={i} className={s.pdBtn}>
                    {b.render({ onClick: b.onClick ?? (() => {}), disabled: b.disabled })}
                  </span>
                ) : (
                  <BasicButton key={i} className={s.pdBtn} text={b.text} icon={b.icon} onClick={b.onClick} disabled={b.disabled} />
                ),
              )}
            </div>
          )}
        </div>
      </div>
    </OverlayPortal>
  );
}
