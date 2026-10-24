// CallButton.tsx — the round call-bar button (Main.qml:1054-1242): 50 px circle (hang-up 72×50
// stadium), off / active / danger / tinted / busy / disabled / focus / slash / badge / ring / pulse
// states and the ▴ options chevron (20 px, top-right −5/−5, rotates 180° while its menu is open).
import { forwardRef, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon, useTip, mergeRefs, BusyIndicator, cssVar, useReducedMotion, type ThemeColourId } from "@/ui";
import s from "./CallButton.module.css";

export interface CallButtonProps {
  icon: string;
  tip?: string;
  active?: boolean;
  danger?: boolean;
  /** tinted fill: push-to-talk key down (green), game chat (blue), pulled aside (gold) — each with its own tokens */
  tint?: CallTint;
  iconColor?: string;
  busy?: boolean;
  /** "live" = enabled; false → 50 % and inert (tooltip still shows) */
  live?: boolean;
  slash?: boolean;
  badge?: string;
  ring?: string;
  pulse?: boolean;
  wide?: boolean;
  /** 11.0.2: the call bar's small pin — a 32 px disc with a 16 px glyph */
  small?: boolean;
  hasMenu?: boolean;
  menuOpen?: boolean;
  onMenu?: (anchor: HTMLElement) => void;
  onClick?: (el: HTMLElement) => void;
  /** dot at the top-right (health) */
  dot?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  "data-id"?: string;
}

/** The tinted variants and their element tokens (fill at rest / hovered / pressed, frame). */
const TINTS = {
  ptt: ["callbar.button.ptt.bg", "callbar.button.ptt.bg.hover", "callbar.button.ptt.bg.pressed", "callbar.button.ptt.border"],
  gameChat: ["callbar.button.gameChat.bg", "callbar.button.gameChat.bg.hover", "callbar.button.gameChat.bg.pressed", "callbar.button.gameChat.border"],
  aside: ["callbar.button.aside.bg", "callbar.button.aside.bg.hover", "callbar.button.aside.bg.pressed", "callbar.button.aside.border"],
} as const satisfies Record<string, readonly [ThemeColourId, ThemeColourId, ThemeColourId, ThemeColourId]>;
export type CallTint = keyof typeof TINTS;

export const CallButton = forwardRef<HTMLDivElement, CallButtonProps>(function CallButton(p, ref) {
  const reduce = useReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const chev = useRef<HTMLButtonElement>(null);
  const [hov, setHov] = useState(false);
  const [down, setDown] = useState(false);
  const [chevHov, setChevHov] = useState(false);
  const live = p.live !== false;
  useTip(btn, p.tip, { delay: 400, placement: "above" });
  useTip(chev, p.hasMenu && !p.menuOpen ? "Settings" : undefined, { delay: 400, placement: "above" });

  // fill at rest / hovered / pressed + frame: each state is its own token (Main.qml's Qt.lighter/darker/rgba steps)
  const pick = (rest: ThemeColourId, hover: ThemeColourId, pressed: ThemeColourId) => cssVar(down ? pressed : hov ? hover : rest);
  let fill: string;
  let border: string;
  if (p.danger) {
    fill = pick("callbar.button.danger.bg", "callbar.button.danger.bg.hover", "callbar.button.danger.bg.pressed");
    border = `1px solid ${cssVar("callbar.button.danger.border")}`;
  } else if (p.tint) {
    const [rest, hover, pressed, frame] = TINTS[p.tint];
    fill = pick(rest, hover, pressed);
    border = `1px solid ${cssVar(frame)}`;
  } else if (p.active) {
    fill = pick("callbar.button.active.bg", "callbar.button.active.bg.hover", "callbar.button.active.bg.pressed");
    border = `1px solid ${cssVar("callbar.button.active.border")}`;
  } else {
    fill = pick("callbar.button.bg", "callbar.button.bg.hover", "callbar.button.bg.pressed");
    border = `1px solid ${cssVar("callbar.button.border")}`;
  }
  // the glyph: filled states (on, muted/hang-up, a tint) keep callbar.button.icon (the on-colour ink); the neutral disc
  // takes callbar.button.icon.off, the bar's own ink — white on the dark veil, the theme's text on a light bar (H16)
  const ink = p.iconColor ?? cssVar(p.danger || p.tint || p.active ? "callbar.button.icon" : "callbar.button.icon.off");
  const act = (el: HTMLElement) => {
    if (!live || p.busy) return;
    p.onClick?.(el);
  };
  return (
    <div
      ref={mergeRefs(ref, box)}
      className={`${s.wrap} ${p.wide ? s.wide : ""} ${p.small ? s.small : ""} ${p.className ?? ""}`}
      style={p.style}
      data-id={p["data-id"]}
    >
      {p.ring && <span className={s.ring} style={{ borderColor: p.ring }} />}
      {/* mounted once per warning (rising edge), so its one-shot pulse never replays while the warning lasts */}
      {p.pulse && !reduce && <span className={s.pulse} />}
      <button
        ref={btn}
        type="button"
        aria-label={p.tip}
        aria-disabled={!live || undefined}
        className={`${s.btn} ${!live ? s.dead : ""}`}
        style={{ background: fill, border }}
        onPointerEnter={() => setHov(true)}
        onPointerLeave={() => (setHov(false), setDown(false))}
        onPointerDown={(e) => e.button === 0 && live && setDown(true)}
        onPointerUp={() => setDown(false)}
        onClick={(e) => act(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            act(e.currentTarget);
          }
        }}
      >
        {!p.busy && (
          <span className={s.glyph} style={{ transform: hov && live ? "scale(1.14)" : undefined }}>
            <Icon name={p.icon} size={p.small ? 16 : 22} color={ink} hovered={hov} active={p.active || p.danger} />
          </span>
        )}
        {p.busy && <BusyIndicator size={26} color={ink} />}
        {p.slash && <span className={s.slash} />}
        {p.badge && <span className={s.badge}>{p.badge}</span>}
      </button>
      {p.children}
      {p.dot && <span className={s.dot} style={{ background: p.dot }} />}
      {p.hasMenu && (
        <button
          ref={chev}
          type="button"
          aria-label="Settings"
          className={s.chev}
          onPointerEnter={() => setChevHov(true)}
          onPointerLeave={() => setChevHov(false)}
          onClick={(e) => {
            e.stopPropagation();
            if (box.current) p.onMenu?.(box.current);
          }}
        >
          <span
            className={s.chevDisc}
            style={{
              background: chevHov || p.menuOpen ? "var(--th-callbar-chevron-bg-hover)" : "var(--th-callbar-chevron-bg)",
              borderColor: chevHov || p.menuOpen ? "var(--th-callbar-chevron-border-hover)" : "var(--th-callbar-chevron-border)",
              transform: chevHov ? "scale(1.15)" : undefined,
            }}
          >
            <svg width="10" height="6" viewBox="0 0 10 6" style={{ transform: p.menuOpen ? "rotate(180deg)" : undefined }} className={s.chevSvg}>
              <path d="M1.2 5 L5 1.2 L8.8 5" fill="none" stroke="var(--th-callbar-chevron-icon)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>
      )}
    </div>
  );
});
