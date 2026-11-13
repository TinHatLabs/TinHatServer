// ActionButton.tsx — one button of a row, drawn from its resolved item (ACTIONS.md §9.4; desktop ActionButton.qml).
//
// Styles (the row kind's `style`): `header` = the room header's round HeaderIconButton (44 px on phones, like the
// header's own; icon + label / label looks draw the tool button at the header's height); `compact` = the room column
// header's 28 px tool button (16 px glyph); everything else = the house ToolButton (ThToolButton): 40 px (scale S) /
// 50 px (scale M), a 22 / 28 px glyph, an optional bold label. Looks: icon | iconLabel | label. A dimmed item is
// disabled at half opacity; a placeholder (a newer Tin Hat's action) is always dimmed. `toggleLook`: "pose" holds the
// glyph's active pose (today's tool rows), "checked" also fills the button (your own button islands, where a toggle
// must read as on/off). A danger action's glyph and label are red; a primary action is the CTA (GlowButton).
// Colours only from theme tokens; nothing animates at rest (hover / press transitions are the house buttons').
import { forwardRef, useEffect, useRef, type CSSProperties, type MouseEvent, type PointerEvent as RPointerEvent } from "react";
import { Avatar, GlowButton, HeaderIconButton, Icon, ToolButton, cx, useIsMobile } from "@/ui";
import type { ItemOut } from "../evaluate";
import type { Look, Scale } from "../table";
import { HoldLatch, holdTargetGone } from "./holdLatch";
import s from "./ActionButton.module.css";

export interface ActionButtonProps {
  item: ItemOut;
  /** the row kind's style */
  rowStyle: string;
  scale: Scale;
  /** "pose" (default) or "checked" — how an active toggle reads */
  toggleLook?: "pose" | "checked";
  /** edit mode: hidden items are drawn too (faint) and nothing runs */
  editing?: boolean;
  onRun?: (el: HTMLElement, e: MouseEvent) => void;
  /** a hold action (push to talk): the press and the release instead of a click */
  onHold?: (el: HTMLElement, down: boolean) => void;
  className?: string;
  style?: CSSProperties;
}

/** The glyph an item draws: its icon, else its target's (a listed value's icon), else null (an avatar / text). */
function glyphOf(item: ItemOut): string | null {
  return item.icon ?? item.targetIcon ?? null;
}

export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(function ActionButton(
  { item, rowStyle, scale, toggleLook = "pose", editing, onRun, onHold, className, style },
  ref,
) {
  const mobile = useIsMobile();
  const dimmed = item.state !== "shown" || !item.known;
  const faint = item.state === "hidden";
  const tip = item.tip ?? item.label;
  const glyph = glyphOf(item);
  const look: Look = item.look;
  const label = look === "icon" ? undefined : item.shortLabel ?? item.label;
  const active = item.active === true;
  const click = (e: MouseEvent<HTMLButtonElement>) => {
    if (editing || dimmed || item.hold) return;
    onRun?.(e.currentTarget, e);
  };
  // a hold action runs on the press and again on the release (or when the pointer leaves / is cancelled). The latch
  // (holdLatch.ts, review round 4 UI-1 r2) keeps the press's own release and runs it exactly once — also when the
  // button unmounts, re-renders elsewhere, dims, leaves edit mode's reach or stops being a hold mid-hold: a held push
  // to talk can never be left open by the UI changing under the finger.
  const latch = useRef<HoldLatch | null>(null);
  if (!latch.current) latch.current = new HoldLatch();
  const holdable = !!item.hold && !editing && !dimmed && !!onHold;
  useEffect(() => {
    // (a fresh latch after a StrictMode / remount cleanup disposed the old one)
    const l = latch.current && !latch.current.disposed ? latch.current : new HoldLatch();
    latch.current = l;
    return () => l.end("unmount");
  }, []);
  useEffect(() => {
    if (!holdable) latch.current?.end("disable");
  }, [holdable]);
  const holdHandlers = item.hold
    ? {
        onPointerDown: (e: RPointerEvent<HTMLButtonElement>) => {
          const l = latch.current;
          if (!holdable || !onHold || !l || l.held || l.disposed) return;
          const el = e.currentTarget;
          const fire = onHold;
          el.setPointerCapture?.(e.pointerId);
          // hidden by CSS (the button or an ancestor) neither unmounts nor reliably ends the pointer: looked at while held
          const watch = window.setInterval(() => {
            if (holdTargetGone(el)) l.end("hide");
          }, 200);
          l.press(
            () => fire(el, true),
            () => {
              window.clearInterval(watch);
              fire(el, false);
            },
            e.pointerId,
          );
        },
        onPointerUp: (e: RPointerEvent<HTMLButtonElement>) => latch.current?.endBy(e.pointerId, "up"),
        onPointerCancel: (e: RPointerEvent<HTMLButtonElement>) => latch.current?.endBy(e.pointerId, "cancel"),
        onLostPointerCapture: (e: RPointerEvent<HTMLButtonElement>) => latch.current?.endBy(e.pointerId, "lostcapture"),
      }
    : {};
  const common = {
    "data-action": item.a,
    "data-state": item.state,
    "data-known": item.known ? undefined : "false",
    "aria-disabled": dimmed || undefined,
  };
  if (item.primary && rowStyle !== "header") {
    return (
      <GlowButton
        ref={ref}
        className={cx(s.primary, faint && s.faint, className)}
        style={style}
        icon={glyph ?? undefined}
        text={look === "icon" ? undefined : item.label}
        tip={tip}
        disabled={dimmed && !editing}
        onClick={click}
        {...common}
      />
    );
  }
  if (rowStyle === "header" && glyph && look === "icon") {
    return (
      <HeaderIconButton
        ref={ref}
        className={cx(faint && s.faint, className)}
        style={style}
        iconName={glyph}
        tip={tip}
        accent={active}
        size={scale === "M" || mobile ? 44 : 36}
        disabled={dimmed && !editing}
        onClick={click}
        {...common}
      />
    );
  }
  const compact = rowStyle === "compact";
  const iconSize = compact ? 16 : scale === "M" ? 28 : 22;
  const colour = !item.known ? "var(--th-action-placeholder-fg)" : item.danger ? "var(--th-action-button-fg-danger)" : undefined;
  // the glyph: an emoji (a status preset's) before the icon, else the target's avatar (a room, a person)
  const emoji = look !== "label" ? item.emoji : null;
  const avatar = !emoji && !glyph && look !== "label" && item.subject !== null && (item.subjectKind === "room" || item.subjectKind === "person" || item.subjectKind === "space");
  return (
    <ToolButton
      ref={ref}
      className={cx(s.tool, compact ? s.compact : scale === "M" ? s.medium : s.small, look === "label" && s.labelOnly, faint && s.faint, dimmed && s.dimmed, className)}
      style={style}
      iconName={look === "label" || avatar || emoji ? undefined : glyph ?? undefined}
      iconSize={iconSize}
      iconColor={colour}
      label={label}
      tip={tip}
      active={active}
      checked={toggleLook === "checked" && active}
      disabled={dimmed && !editing}
      onClick={click}
      {...holdHandlers}
      {...common}
    >
      {emoji && (
        <span className={s.emoji} style={{ order: -1, width: iconSize, height: iconSize, fontSize: Math.round(iconSize * 0.8) }} aria-hidden="true">
          {emoji}
        </span>
      )}
      {avatar && (
        <span className={s.avatar} style={{ order: -1 }}>
          <Avatar size={iconSize} name={item.targetName ?? item.label} seed={item.subject ?? item.label} imageSource={null} />
        </span>
      )}
      {item.split && !compact && <span className={s.splitHint} aria-hidden="true" />}
    </ToolButton>
  );
});

/** The placeholder glyph + label for tests and the edit-mode drawer (a newer Tin Hat's button). */
export function PlaceholderGlyph({ size = 22 }: { size?: number }) {
  return <Icon name="system-software-update" size={size} color="var(--th-action-placeholder-fg)" />;
}
