// Popover.tsx — Controls.Popup, anchored to an item or a point and always kept inside the window.
// Default chrome = the Basic style (palette.window fill, 1 px palette.dark border, padding 12);
// `plain` drops it for the app's custom popovers (StreamPopover, Soundboard, CallOptions … draw
// their own rounded panels). Escape / a press outside close it (closePolicy), `modal` dims and
// blocks the window. On phones it presents as a bottom sheet with a grab handle.
import { useEffect, useRef, useState, useLayoutEffect, type CSSProperties, type ReactNode } from "react";
import { OverlayPortal, placePopup, rectOf, usePopupStack, type Placement, type Rect } from "./overlay";
import { useIsMobile } from "./formFactor";
import { BACK_LEVEL_POPUP, useBackToClose } from "./backStack";
import { cx } from "./hooks";
import s from "./Popover.module.css";
import { focusInto, lastInputWasKeyboard, useFocusReturn } from "./focus";
import { trapTab } from "./Dialog";

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchor?: HTMLElement | Rect | { x: number; y: number } | null;
  placement?: Placement;
  align?: "start" | "center" | "end";
  gap?: number;
  /** Qt Popup.margins: kept from the window edge (default 6) */
  margins?: number;
  /** flip to the opposite side when it doesn't fit (default true) */
  flip?: boolean;
  offset?: { x: number; y: number };
  modal?: boolean;
  closeOnOutside?: boolean;
  closeOnEscape?: boolean;
  /** no Basic chrome (the caller styles the panel) */
  plain?: boolean;
  padding?: number;
  /** phones: present as a bottom sheet (default true) */
  sheetOnMobile?: boolean;
  title?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  role?: string;
  "aria-label"?: string;
}

function toRect(a: PopoverProps["anchor"]): Rect | null {
  if (!a) return null;
  if (a instanceof HTMLElement) return rectOf(a);
  if ("width" in a) return a;
  return { x: a.x, y: a.y, width: 0, height: 0 };
}

export function Popover(p: PopoverProps) {
  const mobile = useIsMobile();
  if (!p.open) return null;
  if (mobile && p.sheetOnMobile !== false) return <PopoverSheet {...p} />;
  return <DesktopPopover {...p} />;
}

function DesktopPopover({
  onClose,
  anchor,
  placement = "below",
  align = "start",
  gap = 0,
  margins = 6,
  flip = true,
  offset,
  modal,
  closeOnOutside = true,
  closeOnEscape = true,
  plain,
  padding,
  className,
  style,
  children,
  role = "dialog",
  ...aria
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  usePopupStack(true, ref, {
    onEscape: closeOnEscape ? onClose : undefined,
    onOutside: closeOnOutside ? onClose : undefined,
    inside: () => [anchor instanceof HTMLElement ? anchor : null],
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const a = toRect(anchor) ?? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
      const size = { width: el.offsetWidth, height: el.offsetHeight };
      setPos(placePopup({ anchor: a, size, placement: toRect(anchor) ? placement : "center", align, gap, margins, flip, offset }));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [anchor, placement, align, gap, margins, flip, offset]);
  // keyboard (a11y pass; Qt's Popup takes the focus and keeps Tab inside): once placed (a hidden popup can't take focus),
  // focus goes in — to its first control when it was opened from the keyboard, else to the popup itself (no ring) —
  // unless something inside already took it (a picker's search field); it goes back when the popup closes
  const shown = pos !== null;
  useEffect(() => {
    const el = ref.current;
    if (shown && el) focusInto(el, lastInputWasKeyboard());
  }, [shown]);
  useFocusReturn(ref);
  return (
    <OverlayPortal>
      {modal && <div className={s.dim} />}
      <div
        ref={ref}
        role={role}
        aria-label={aria["aria-label"]}
        tabIndex={-1}
        onKeyDown={(e) => trapTab(e, ref.current)}
        className={cx(s.pop, !plain && s.basic, className)}
        style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? "visible" : "hidden", padding, ...style }}
      >
        {children}
      </div>
    </OverlayPortal>
  );
}

function PopoverSheet({ onClose, closeOnOutside = true, title, children, className, role = "dialog", ...aria }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  usePopupStack(true, ref, { onEscape: onClose, onOutside: closeOnOutside ? onClose : undefined });
  useBackToClose(true, onClose, BACK_LEVEL_POPUP); // phones: back closes the sheet (shared back stack)
  // a screen reader (VoiceOver / TalkBack) or a keyboard lands in the sheet and goes back when it closes (a11y pass);
  // opened by touch the sheet itself takes the focus (no on-screen keyboard pops up for a field the user didn't tap)
  useEffect(() => {
    const el = ref.current;
    if (el) focusInto(el, lastInputWasKeyboard()); // a hardware keyboard: its first control, like the desktop popover
  }, []);
  useFocusReturn(ref);
  return (
    <OverlayPortal>
      <div className={s.sheetDim} />
      <div ref={ref} role={role} aria-label={aria["aria-label"] ?? title} tabIndex={-1} onKeyDown={(e) => trapTab(e, ref.current)} className={cx(s.sheet, className)}>
        <div className={s.grab} />
        {title && <div className={s.sheetTitle}>{title}</div>}
        <div className={s.sheetBody}>{children}</div>
      </div>
    </OverlayPortal>
  );
}
