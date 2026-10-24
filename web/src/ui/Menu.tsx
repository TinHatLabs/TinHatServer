// Menu.tsx — Controls.Menu / MenuItem / MenuSeparator (Qt Quick Controls Basic, the app palette),
// CheckMenuItem.qml, MenuSectionLabel.qml, submenus, the right-click ContextMenu, and — on phones —
// the same content as a bottom sheet (ARCHITECTURE "mobile").
//
// Desktop look (measured on the native app menu): 200 px wide, palette.window fill with a 1 px
// palette.dark border, no padding; items 40 px (background inset 1 px) with padding 6, spacing 6,
// a 24 px icon and 12 px windowText label (elided); hover = palette.light, press = palette.midlight;
// checkable items reserve a 28 px indicator (Qt's tick) before the icon; submenus draw an arrow on
// the right and cascade to the right (overlap 1); separators are 1 px palette.mid, 196 wide, 13 tall.
// Menus shift to stay inside the window (margins 0). Keyboard: ↑/↓, Home/End, Enter/Space, → opens
// a submenu, ←/Esc closes it; typing a letter jumps to the next item starting with it.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as RMouseEvent,
  type PointerEvent as RPointerEvent,
  type ReactNode,
} from "react";
import { Icon } from "./Icon";
import { OverlayPortal, placePopup, rectOf, usePopupStack, type Rect } from "./overlay";
import { useIsMobile } from "./formFactor";
import { BACK_LEVEL_POPUP, useBackToClose } from "./backStack";
import { cx } from "./hooks";
import s from "./Menu.module.css";

export type MenuAnchor = HTMLElement | Rect | { x: number; y: number } | null | undefined;

interface MenuCtx {
  close: () => void; // close the whole tree
  closeSelf: () => void;
  highlight: string | null;
  setHighlight: (id: string | null) => void;
  openSub: string | null;
  setOpenSub: (id: string | null) => void;
  mobile: boolean;
  push: (title: string, content: ReactNode) => void;
  menuEl: () => HTMLElement | null;
  depth: number;
}
const Ctx = createContext<MenuCtx | null>(null);

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  /** element → below it, left-aligned (Qt `popup(item, 0, item.height)`); point → at it */
  anchor?: MenuAnchor;
  placement?: "below" | "above" | "right" | "left" | "at";
  offset?: { x: number; y: number };
  /** dim + block the window (Controls.Popup modal) */
  modal?: boolean;
  width?: number;
  /** heading of the bottom sheet on phones */
  title?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  /** internal: nested submenu */
  _parent?: MenuCtx;
  _subRect?: Rect;
}

function toRect(a: MenuAnchor): { rect: Rect; point: boolean } | null {
  if (!a) return null;
  if (a instanceof HTMLElement) {
    const r = rectOf(a);
    return r ? { rect: r, point: false } : null;
  }
  if ("width" in a) return { rect: a, point: false };
  return { rect: { x: a.x, y: a.y, width: 0, height: 0 }, point: true };
}

export function Menu(p: MenuProps) {
  const mobile = useIsMobile();
  if (!p.open) return null;
  if (mobile && !p._parent) return <MenuSheet {...p} />;
  return <DesktopMenu {...p} />;
}

function DesktopMenu({ open, onClose, anchor, placement, offset, modal, width = 200, className, style, children, _parent, _subRect }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [openSub, setOpenSub] = useState<string | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const anchorInfo = useMemo(() => toRect(anchor), [anchor]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    if (_subRect) {
      // cascade: to the right of the parent menu, first item level with the parent item
      setPos(placePopup({ anchor: _subRect, size, placement: "right", align: "start", gap: -1, margins: 0, flip: true }));
      return;
    }
    if (!anchorInfo) {
      setPos(placePopup({ anchor: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }, size, placement: "center", margins: 0 }));
      return;
    }
    const pl = placement ?? (anchorInfo.point ? "at" : "below");
    setPos(placePopup({ anchor: anchorInfo.rect, size, placement: pl, align: "start", margins: 0, offset }));
  }, [anchorInfo, placement, offset, _subRect]);

  const closeAll = useCallback(() => {
    if (_parent) _parent.close();
    else onClose();
  }, [_parent, onClose]);

  usePopupStack(open, ref, {
    onEscape: onClose,
    onOutside: _parent ? undefined : onClose,
    // a press on the button that opened the menu is the button's to handle (toggle)
    inside: () => [anchor instanceof HTMLElement ? anchor : null],
  });

  // focus the menu so the keyboard works (Qt gives the menu focus)
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  const ctx: MenuCtx = {
    close: closeAll,
    closeSelf: onClose,
    highlight,
    setHighlight,
    openSub,
    setOpenSub,
    mobile: false,
    push: () => {},
    menuEl: () => ref.current,
    depth: (_parent?.depth ?? 0) + 1,
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const el = ref.current;
    if (!el) return;
    const items = [...el.querySelectorAll<HTMLElement>(":scope > [data-menuitem]:not([data-disabled])")];
    const idx = items.findIndex((i) => i.dataset.menuitem === highlight);
    const go = (i: number) => {
      const it = items[(i + items.length) % items.length];
      if (it) {
        setHighlight(it.dataset.menuitem!);
        it.scrollIntoView({ block: "nearest" });
      }
    };
    if (e.key === "ArrowDown") go(idx + 1);
    else if (e.key === "ArrowUp") go(idx < 0 ? -1 : idx - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    else if (e.key === "Enter" || e.key === " ") {
      if (idx >= 0) items[idx].click();
    } else if (e.key === "ArrowRight") {
      if (idx >= 0 && items[idx].dataset.submenu) setOpenSub(items[idx].dataset.menuitem!);
    } else if (e.key === "ArrowLeft") {
      if (_parent) onClose();
      else return;
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const k = e.key.toLowerCase();
      const start = idx + 1;
      for (let n = 0; n < items.length; n++) {
        const it = items[(start + n) % items.length];
        if ((it.textContent ?? "").trim().toLowerCase().startsWith(k)) {
          setHighlight(it.dataset.menuitem!);
          break;
        }
      }
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <OverlayPortal>
      {modal && !_parent && <div className={s.dim} onPointerDown={(e) => e.preventDefault()} />}
      <div
        ref={ref}
        role="menu"
        tabIndex={-1}
        className={cx(s.menu, className)}
        // D2: sized to the content with the Basic 200 px as the minimum (the rig's fixed 200 px clipped
        // "Tuck nav into corner (OLED)", "Record calls here (Memories)…" and the volume menu's rows)
        style={{ minWidth: width, width: "max-content", maxWidth: "calc(100vw - 8px)", left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? "visible" : "hidden", ...style }}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        <Ctx.Provider value={ctx}>{children}</Ctx.Provider>
      </div>
    </OverlayPortal>
  );
}

// ---- items -----------------------------------------------------------------------------------

export interface MenuItemProps {
  text: ReactNode;
  icon?: string;
  onTriggered?: () => void;
  disabled?: boolean;
  /** CheckMenuItem: checkable + current state */
  checkable?: boolean;
  checked?: boolean;
  /** keep the menu open after triggering */
  keepOpen?: boolean;
  /** right-aligned shortcut hint (web addition used by registry menus) */
  shortcut?: string;
  /** something drawn at the row's right end, after the (elided) text — e.g. the ☰ Theme menu's swatch (THEMES-UI §12) */
  trailing?: ReactNode;
  danger?: boolean;
  /** gallery: force hover/pressed */
  force?: "hover" | "pressed";
  className?: string;
}

export function MenuItem({ text, icon, onTriggered, disabled, checkable, checked, keepOpen, shortcut, trailing, danger, force, className }: MenuItemProps) {
  const ctx = useContext(Ctx);
  const id = useId();
  const [down, setDown] = useState(false);
  if (!ctx) return null;
  const hl = ctx.highlight === id || force === "hover";
  const trigger = () => {
    if (disabled) return;
    onTriggered?.();
    if (!keepOpen) ctx.close();
  };
  return (
    <div
      role={checkable ? "menuitemcheckbox" : "menuitem"}
      aria-checked={checkable ? !!checked : undefined}
      aria-disabled={disabled || undefined}
      data-menuitem={id}
      data-disabled={disabled ? "" : undefined}
      className={cx(s.item, ctx.mobile && s.mItem, hl && !disabled && s.hl, (down || force === "pressed") && !disabled && s.down, className)}
      onPointerEnter={(e: RPointerEvent) => {
        if (e.pointerType === "touch") return;
        if (!disabled) ctx.setHighlight(id);
        ctx.setOpenSub(null);
      }}
      onPointerDown={(e) => {
        if (e.button === 0) setDown(true);
      }}
      onPointerUp={() => setDown(false)}
      onPointerLeave={() => setDown(false)}
      onClick={trigger}
    >
      <ItemContent text={text} icon={icon} checkable={checkable} checked={checked} hovered={hl} disabled={disabled} shortcut={shortcut} trailing={trailing} danger={danger} />
    </div>
  );
}

/** CheckMenuItem.qml — a MenuItem with the native check indicator; `checked` stays declarative. */
export function CheckMenuItem(p: Omit<MenuItemProps, "checkable">) {
  return <MenuItem {...p} checkable />;
}

function ItemContent({
  text,
  icon,
  checkable,
  checked,
  hovered,
  disabled,
  submenu,
  shortcut,
  trailing,
  danger,
  mobile,
}: {
  text: ReactNode;
  icon?: string;
  checkable?: boolean;
  checked?: boolean;
  hovered?: boolean;
  disabled?: boolean;
  submenu?: boolean;
  mobile?: boolean;
  shortcut?: string;
  trailing?: ReactNode;
  danger?: boolean;
}) {
  const color = danger ? "var(--th-menu-item-danger-fg)" : "var(--th-menu-item-icon)";
  // a stock MenuItem draws icon.name through QIcon (the static glyph, 24 px); the item Qt makes
  // for a sub-Menu gets the menu's icon at its natural 16 px. In a phone's bottom sheet every row
  // keeps the 24 px icon so the labels line up (the 16 px glyph there read as a misaligned row)
  const iconSize = submenu && !mobile ? 16 : 24;
  return (
    <>
      {checkable && (
        <span className={s.indicator}>
          {checked && (
            <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden>
              <path d="M1.5 6.2 L5.2 9.8 L12.5 1.8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
            </svg>
          )}
        </span>
      )}
      {icon && <Icon name={icon} size={iconSize} color={color} staticOnly className={s.icon} />}
      {/* phone sheets: an icon-less submenu row ("Notifications ▸") keeps the icon column so its label
          lines up with the rows around it */}
      {!icon && mobile && submenu && <span className={s.icon} style={{ width: 24, height: 24, flex: "none" }} aria-hidden />}
      <span className={s.text} style={danger ? { color } : undefined}>
        {text}
      </span>
      {trailing && <span className={s.trailing}>{trailing}</span>}
      {shortcut && <span className={s.shortcut}>{shortcut}</span>}
      {submenu && (
        <span className={s.arrow} aria-hidden>
          <svg width="12" height="18" viewBox="0 0 12 18">
            <path d="M2.5 1.5 L9.5 9 L2.5 16.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      )}
    </>
  );
}

export function MenuSeparator() {
  const ctx = useContext(Ctx);
  return <div role="separator" className={cx(s.sep, ctx?.mobile && s.mSep)} />;
}

/** MenuSectionLabel.qml — dim bold small-font heading inside a menu. */
export function MenuSectionLabel({ text, children }: { text?: ReactNode; children?: ReactNode }) {
  const ctx = useContext(Ctx);
  return <div className={cx(s.section, ctx?.mobile && s.mSection)}>{text ?? children}</div>;
}

/** A nested Controls.Menu { title; icon.name } — cascades on hover (and →), click toggles it. */
export function SubMenu({ title, icon, children, disabled, width }: { title: string; icon?: string; children: ReactNode; disabled?: boolean; width?: number }) {
  const ctx = useContext(Ctx);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (!ctx) return null;
  const open = ctx.openSub === id;
  const hl = ctx.highlight === id || open;
  if (ctx.mobile) {
    return (
      <div
        role="menuitem"
        aria-haspopup="menu"
        data-menuitem={id}
        className={cx(s.item, s.mItem)}
        onClick={() => !disabled && ctx.push(title, children)}
      >
        <ItemContent text={title} icon={icon} submenu mobile disabled={disabled} />
      </div>
    );
  }
  return (
    <>
      <div
        ref={ref}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        data-menuitem={id}
        data-submenu="1"
        data-disabled={disabled ? "" : undefined}
        className={cx(s.item, hl && !disabled && s.hl)}
        onPointerEnter={(e) => {
          if (e.pointerType === "touch" || disabled) return;
          ctx.setHighlight(id);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => ctx.setOpenSub(id), 150);
        }}
        onPointerLeave={() => window.clearTimeout(timer.current)}
        onClick={(e: RMouseEvent) => {
          e.stopPropagation();
          if (!disabled) ctx.setOpenSub(open ? null : id);
        }}
      >
        <ItemContent text={title} icon={icon} submenu hovered={hl} disabled={disabled} />
      </div>
      {open && ref.current && (
        <Menu
          open
          onClose={() => {
            ctx.setOpenSub(null);
            ctx.menuEl()?.focus({ preventScroll: true });
          }}
          width={width}
          _parent={ctx}
          _subRect={subRect(ref.current)}
        >
          {children}
        </Menu>
      )}
    </>
  );
}

function subRect(item: HTMLElement): Rect {
  const r = item.getBoundingClientRect();
  const menu = item.parentElement!.getBoundingClientRect();
  return { x: menu.left, y: r.top, width: menu.width, height: r.height };
}

// ---- phones: the bottom sheet --------------------------------------------------------------

function MenuSheet({ open, onClose, title, children }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [stack, setStack] = useState<Array<{ title: string; content: ReactNode }>>([]);
  usePopupStack(open, ref, { onEscape: onClose, onOutside: onClose });
  // the browser / Android back button: a pushed submenu page goes back to its parent first, then the
  // sheet closes (ARCHITECTURE "mobile"; shared phone back stack)
  useBackToClose(open, () => {
    if (stack.length) {
      setStack((st) => st.slice(0, -1));
      return false;
    }
    onClose();
  }, BACK_LEVEL_POPUP);
  const top = stack[stack.length - 1];
  const ctx: MenuCtx = {
    close: onClose,
    closeSelf: onClose,
    highlight: null,
    setHighlight: () => {},
    openSub: null,
    setOpenSub: () => {},
    mobile: true,
    push: (t, c) => setStack((st) => [...st, { title: t, content: c }]),
    menuEl: () => ref.current,
    depth: 1,
  };
  return (
    <OverlayPortal>
      <div className={s.sheetDim} />
      <div ref={ref} role="menu" className={s.sheet}>
        <div className={s.grab} />
        {(top || title) && (
          <div className={s.sheetTitle}>
            {top && (
              <button type="button" className={s.back} onClick={() => setStack((st) => st.slice(0, -1))} aria-label="Back">
                <Icon name="go-previous-symbolic" size={22} />
              </button>
            )}
            <span>{top ? top.title : title}</span>
          </div>
        )}
        <div className={s.sheetBody}>
          <Ctx.Provider value={ctx}>{top ? top.content : children}</Ctx.Provider>
        </div>
      </div>
    </OverlayPortal>
  );
}

// ---- helpers ---------------------------------------------------------------------------------

/** Imperative menu state: `const m = useMenu(); <button onClick={e => m.openAt(e.currentTarget)}>`. */
export function useMenu() {
  const [state, setState] = useState<{ open: boolean; anchor: MenuAnchor }>({ open: false, anchor: null });
  return {
    open: state.open,
    anchor: state.anchor,
    /** open at `anchor`; a second call with the same anchor while open closes it (toggle) */
    openAt: useCallback(
      (anchor: MenuAnchor) => setState((st) => (st.open && st.anchor === anchor ? { ...st, open: false } : { open: true, anchor })),
      [],
    ),
    close: useCallback(() => setState((st) => ({ ...st, open: false })), []),
    props: { open: state.open, anchor: state.anchor, onClose: () => setState((st) => ({ ...st, open: false })) },
  };
}

export interface ContextMenuProps {
  /** the menu content; return null for "no menu here" */
  menu: (close: () => void) => ReactNode;
  children: ReactNode;
  disabled?: boolean;
  modal?: boolean;
  width?: number;
  title?: string;
  /** long-press delay on touch (ms) */
  longPress?: number;
}

/** Right-click (and long-press on touch) opens `menu` at the pointer. */
export function ContextMenu({ menu, children, disabled, modal, width, title, longPress = 500 }: ContextMenuProps) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const lp = useRef<{ t: number; x: number; y: number } | null>(null);
  const close = useCallback(() => setAt(null), []);
  const content = at ? menu(close) : null;
  return (
    <span
      style={{ display: "contents" }}
      onContextMenu={(e) => {
        if (disabled) return;
        e.preventDefault();
        e.stopPropagation();
        setAt({ x: e.clientX, y: e.clientY });
      }}
      onPointerDown={(e) => {
        if (disabled || e.pointerType !== "touch") return;
        const x = e.clientX, y = e.clientY;
        lp.current = { t: window.setTimeout(() => setAt({ x, y }), longPress), x, y };
      }}
      onPointerMove={(e) => {
        const l = lp.current;
        if (l && Math.hypot(e.clientX - l.x, e.clientY - l.y) > 10) {
          window.clearTimeout(l.t);
          lp.current = null;
        }
      }}
      onPointerUp={() => {
        if (lp.current) window.clearTimeout(lp.current.t);
        lp.current = null;
      }}
    >
      {children}
      {at && content && (
        <Menu open onClose={close} anchor={at} modal={modal} width={width} title={title}>
          {content}
        </Menu>
      )}
    </span>
  );
}
