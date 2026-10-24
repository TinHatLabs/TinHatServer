// ThemeCard.tsx — THEMES-UI.md §5: a theme card (a live miniature of Tin Hat painted from 15 roles of the card's own
// theme — never a full render), the tiles (All themes, Import a theme) and the ⋯ button of a My-theme card.
import { useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { Theme } from "@/theme/engine";
import { Icon, Menu, cx, useMenu, useTip } from "@/ui";
import { miniRoles } from "@/ui/themeLibrary";
import s from "./ThemeCard.module.css";

export interface ThemeCardProps {
  doc: Theme;
  /** a library theme (its miniature is cached by id) */
  library?: boolean;
  active: boolean;
  onPick: () => void;
  /** My themes: the ⋯ menu's items */
  menu?: (close: () => void) => ReactNode;
  onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
  tabIndex?: number;
}

const ROWS = [0.6, 0.45, 0.52];

export function ThemeCard({ doc, library, active, onPick, menu, onKeyDown, tabIndex }: ThemeCardProps) {
  const m = miniRoles(doc, library);
  const ref = useRef<HTMLButtonElement>(null);
  const author = typeof doc.author === "string" && doc.author.trim() ? doc.author.trim() : null;
  useTip(
    ref,
    m.ok
      ? `${doc.name}${author ? ` · by ${author}` : ""} · ${m.variant === "light" ? "Light" : "Dark"} theme`
      : `${doc.name} can't be used by this version of Tin Hat (${m.error?.split(":")[0] ?? "refused"})`,
  );
  const r = m.roles;
  const style = (
    m.ok
      ? {
          "--mw": r["surface.window"],
          "--mi": r["surface.island"],
          "--mr": r["surface.raised"],
          "--ms": r["surface.selected"],
          "--mbs": r["border.subtle"],
          "--mtp": r["text.primary"],
          "--mts": r["text.secondary"],
          "--mta": r["text.onAccent"],
          "--ma": r["accent.base"],
          "--mab": r["accent.bright"],
        }
      : {}
  ) as CSSProperties;
  return (
    <div className={s.cell}>
      <button
        ref={ref}
        type="button"
        role="radio"
        aria-checked={active}
        aria-label={`${doc.name} theme`}
        className={cx(s.card, active && s.on, !m.ok && s.bad)}
        style={style}
        data-theme-id={doc.id}
        tabIndex={tabIndex}
        onKeyDown={onKeyDown}
        onClick={() => m.ok && !active && onPick()}
      >
        {m.ok ? (
          <span className={s.mini} aria-hidden>
            <span className={s.dot} style={{ top: 6, background: r["accent.base"] }} />
            <span className={s.dot} style={{ top: 17, background: r["name.1"] }} />
            <span className={s.dot} style={{ top: 28, background: r["name.2"] }} />
            <span className={s.rooms}>
              {ROWS.map((w, i) => (
                <span key={i} className={s.row} style={{ top: 5 + i * 11 }}>
                  {i === 1 && <span className={s.band} />}
                  <span className={s.rowDot} style={{ background: r[`name.${i + 3}` as "name.3"] }} />
                  <span className={s.rowBar} style={{ width: `calc((100% - 16px) * ${w})` }} />
                </span>
              ))}
            </span>
            <span className={s.main}>
              <span className={s.header} />
              <span className={s.theirs} />
              <span className={s.yours} />
              <span className={s.composer} />
            </span>
          </span>
        ) : (
          <span className={cx(s.mini, s.badMini)} aria-hidden>
            <Icon name="dialog-warning" size={22} color="var(--th-settings-theme-note-icon)" />
          </span>
        )}
        <span className={s.caption}>
          <span className={cx(s.name, !m.ok && s.badName)}>{doc.name}</span>
          {active && (
            <span className={s.check} aria-hidden>
              <Icon name="checkmark-symbolic" size={10} color="var(--mta)" />
            </span>
          )}
        </span>
      </button>
      {menu && <MoreButton name={doc.name} menu={menu} />}
    </div>
  );
}

function MoreButton({ name, menu }: { name: string; menu: (close: () => void) => ReactNode }) {
  const m = useMenu();
  const ref = useRef<HTMLButtonElement>(null);
  useTip(ref, "More");
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={s.more}
        aria-label={`More for ${name}`}
        aria-haspopup="menu"
        aria-expanded={m.open}
        onClick={(e) => {
          e.stopPropagation();
          m.openAt(e.currentTarget);
        }}
      >
        <Icon name="view-more-symbolic" size={16} color="var(--th-settings-theme-card-menu-icon)" />
      </button>
      {m.open && (
        <Menu {...m.props} title={name}>
          {menu(m.close)}
        </Menu>
      )}
    </>
  );
}

export function ThemeTile({ icon, label, onClick, tabIndex, onKeyDown }: { icon: string; label: string; onClick: () => void; tabIndex?: number; onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void }) {
  return (
    <div className={s.cell}>
      <button type="button" className={s.tile} onClick={onClick} tabIndex={tabIndex} onKeyDown={onKeyDown}>
        <Icon name={icon} size={22} color="var(--th-settings-theme-tile-icon)" />
        <span className={s.tileLabel}>{label}</span>
      </button>
    </div>
  );
}

export { s as cardStyles };
